import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { DISC_CHANGED_MESSAGE } from '../../engine/disc/http-transport';
import type { DiscEntry, DiscManifest } from '../../engine/disc/nas-api';
import type { BufferRequest } from '../../engine/protocol';
import type { PlayerController } from '../../player/player-controller';
import { BUFFER_FAILED_COPY, bufferPlan, playlistFacts, readAheadCacheBytes, storageRoom, tooBigCopy, waitCopy, watchBufferFailure, type BufferPlan } from './buffer-model';
import { discBadges, discFacts, formatSize, mainPlaylist, openFailed, playlistOf, preflightLines, type DiscFacts } from './library-model';
import { nasDiscSpec } from './disc-spec';
import { NasHttpError, type NasClient } from './nas-client';
import { playOnceOpen } from './play-once-open';

/** The disc to open: a folder listing's row, or a title's disc, whose size is only known from its manifest. */
export type PreflightDisc = Pick<DiscEntry, 'id' | 'name' | 'kind'> & { readonly sizeBytes: number | null };

interface PreflightProps {
  readonly nas: NasClient;
  readonly controller: PlayerController;
  readonly disc: PreflightDisc;
  /** An episode's playlist, started once the engine has read the disc (its 'titles' event). */
  readonly playlistId?: string;
  /** Whether the disc is UHD, once its manifest has shown it (for the row's badge). */
  readonly onFacts: (discId: string, facts: DiscFacts) => void;
  readonly onCancel: () => void;
}

/** A disc gone (or replaced) since its folder was listed answers 404 disc-changed. */
const message = (err: unknown): string =>
  err instanceof NasHttpError && err.code === 'disc-changed' ? DISC_CHANGED_MESSAGE : err instanceof Error ? err.message : String(err);

/** ?bufferask=1 is test-only (E2E): every wait asks first (no silent buffering), so `ask` shows with a short synthetic disc. */
const askEveryWait = (): boolean => new URLSearchParams(globalThis.location?.search ?? '').get('bufferask') === '1';

/**
 * Before a NAS disc plays: its manifest, this connection's throughput against the disc's peak rate, and Play. When the
 * connection is slower than the main title (buffer first), Play buffers ahead first: silently for a short wait, else
 * after asking (Wait, or Play now with pauses); a device that can't hold the wait offers pauses.
 */
export function Preflight({ nas, controller, disc, playlistId, onFacts, onCancel }: PreflightProps): ReactElement {
  const [manifest, setManifest] = useState<DiscManifest | null>(null);
  const [facts, setFacts] = useState<DiscFacts | null>(null);
  /** undefined while probing; null when there is no measurement (no clip to probe, or it failed). */
  const [mbps, setMbps] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** The storage the read-ahead cache can use, asked for only when the connection is slower than the title. */
  const [quota, setQuota] = useState<number | undefined>(undefined);
  /**
   * 'launched' once the engine opens the disc ('buffering' while it buffers first): an open that fails there (shown as
   * the player's error) ends it.
   */
  const [opening, setOpening] = useState<'idle' | 'starting' | 'buffering' | 'launched'>('idle');
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const engineFailed = openFailed(snapshot);
  /** Releases the wait for this open's playlists (playOnceOpen); this pre-flight going away ends it too. */
  const releaseWait = useRef<(() => void) | null>(null);
  useEffect(() => () => releaseWait.current?.(), []);
  useEffect(() => {
    if ((opening === 'launched' || opening === 'buffering') && engineFailed) setOpening('idle');
  }, [opening, engineFailed]);

  useEffect(() => {
    let live = true;
    nas.manifest(disc.id).then(
      (m) => {
        if (!live) return;
        const f = discFacts(m);
        setManifest(m);
        setFacts(f);
        onFacts(disc.id, f);
      },
      (err: unknown) => {
        if (live) setError(message(err));
      },
    );
    // A disc without a clip answers 404: no throughput line, and playback isn't held up.
    nas.probe(disc.id).then(
      ({ mbps: measured }) => {
        if (live) setMbps(measured);
      },
      () => {
        if (live) setMbps(null);
      },
    );
    return () => {
      live = false;
    };
    // The probe runs once per disc opened here; onFacts is left out on purpose (a new callback is no new disc).
  }, [nas, disc.id]);

  /**
   * The length and bytes of what plays (the episode's playlist, else the main title's) against this connection; null
   * until both are known (or with no playlist).
   */
  const need = useMemo(() => {
    const playlist = manifest && ((playlistId !== undefined ? playlistOf(manifest, playlistId) : null) ?? mainPlaylist(manifest));
    if (!playlist || typeof mbps !== 'number') return null;
    const sizes = new Map(manifest.files.map((f) => [f.path, f.size]));
    return { ...playlistFacts(playlist.playItems, sizes), connectionMbps: mbps };
  }, [manifest, mbps, playlistId]);
  /** Whether the connection keeps up, before the storage is asked for (persist() can prompt). */
  const keepsUp = need !== null && bufferPlan({ ...need, quotaBytes: Infinity }).kind === 'play';
  /** The connection is slower, and this device can't keep a read-ahead cache (the engine said at its start). */
  const cannotBuffer = need !== null && !keepsUp && snapshot.readAheadCache === false;
  useEffect(() => {
    if (need === null || keepsUp || cannotBuffer) return;
    let live = true;
    const storage = globalThis.navigator?.storage;
    const reclaimable = typeof storage?.getDirectory === 'function' ? () => readAheadCacheBytes(() => storage.getDirectory()) : undefined;
    void storageRoom(storage, reclaimable).then((room) => {
      if (live) setQuota(room);
    });
    return () => {
      live = false;
    };
  }, [need, keepsUp, cannotBuffer]);
  /** The storage estimate is still pending: what Play would do isn't known yet. */
  const estimating = need !== null && !keepsUp && !cannotBuffer && quota === undefined;
  /** null while unknown (or when the device can't buffer): Play then plays at once, as without a measurement. */
  const plan: BufferPlan | null =
    need === null ? (mbps === null ? { kind: 'play' } : null) : keepsUp ? { kind: 'play' } : cannotBuffer || quota === undefined ? null : bufferPlan({ ...need, quotaBytes: quota, ...(askEveryWait() ? { silentBelowS: 0 } : {}) });

  /** `hold`: the disc opens once the cache holds the target (Wait); otherwise at once, its fill going on behind it. */
  const play = (bufferFirst?: BufferRequest, hold = true): void => {
    if (!manifest) return;
    controller.startAudio(); // inside the click gesture
    setOpening('starting');
    setError(null);
    Promise.all([nas.discBase(disc.id), nas.session()]).then(
      ([base, session]) => {
        // The engine asks again only after the NAS refused the token it has, so that one is never handed back.
        let token = session.token;
        const { spec, release } = nasDiscSpec(base, token, manifest, nas.discFetch);
        controller.openRemote(spec, () => nas.freshSession(token).then((s) => (token = s.token)), release, bufferFirst);
        if (bufferFirst && !hold) controller.cancelBuffer(); // play now: the queued open doesn't wait for its fill
        releaseWait.current?.();
        releaseWait.current = playlistId === undefined ? null : playOnceOpen(controller, playlistId);
        if (bufferFirst) watchBufferFailure(controller); // for as long as this disc is open, past this screen
        setOpening(bufferFirst && hold ? 'buffering' : 'launched');
      },
    ).catch((err: unknown) => {
      setOpening('idle');
      setError(message(err));
    });
  };

  /** Buffer first: the bytes the plan holds ahead, from the start of what plays. */
  const request = (bytes: number): BufferRequest => ({ fromSeconds: 0, targetBytes: Math.ceil(bytes), ...(playlistId !== undefined ? { playlistId } : {}) });
  const waitFor = (bytes: number): void => play(request(bytes));
  /**
   * Play now with pauses: at once, with a fill ahead of playback (capped at the plan's lead, or what the device can
   * hold) for fewer pauses; without a cache, as before.
   */
  const playWithPauses = (): void => {
    const lead = plan?.kind === 'ask' ? plan.bytes : plan?.kind === 'too-big' ? plan.canHoldBytes : 0;
    if (lead > 0) play(request(lead), false);
    else play();
  };
  const stopWaiting = (): void => {
    controller.closeDisc(); // the engine drops the disc unopened
    setOpening('idle');
  };
  const buffer = snapshot.buffer;
  const percent = buffer && buffer.targetBytes > 0 ? Math.min(100, Math.floor((buffer.bytes / buffer.targetBytes) * 100)) : 0;

  const lines = preflightLines(mbps ?? null, facts?.peakMbps ?? null);
  const badges = discBadges(disc, facts?.uhd);
  const size = disc.sizeBytes ?? (manifest ? manifest.files.reduce((sum, f) => sum + f.size, 0) : null);

  return (
    <section className="preflight" data-testid="nas-preflight">
      <h3>{disc.name}</h3>
      <p className="library-meta">
        {size !== null && formatSize(size)}
        {badges.map((b) => (
          <span key={b} className="badge">
            {b}
          </span>
        ))}
      </p>
      {mbps === undefined && !error && <p className="status">Measuring this connection…</p>}
      {lines.map((line) => (
        <p key={line} className="status" data-testid="nas-preflight-line">
          {line}
        </p>
      ))}
      {error && (
        <div className="error-banner" role="alert" data-testid="nas-error">
          {error}
        </div>
      )}
      {opening === 'buffering' ? (
        <>
          <div className="buffer-progress" data-testid="nas-buffering" role="progressbar" aria-label="Buffering" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <svg viewBox="0 0 36 36" className="buffer-ring" aria-hidden="true">
              <circle cx="18" cy="18" r="15.5" className="buffer-ring-track" />
              <circle cx="18" cy="18" r="15.5" className="buffer-ring-fill" pathLength={100} strokeDasharray={`${percent} 100`} />
            </svg>
            <span>Buffering… {percent}%</span>
          </div>
          <div className="preflight-actions">
            <button type="button" data-testid="nas-play-now" onClick={() => controller.cancelBuffer()}>
              Play now with pauses
            </button>
            <button type="button" onClick={stopWaiting}>
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          {plan?.kind === 'ask' && (
            <p className="status" data-testid="nas-buffer-wait">
              {waitCopy(plan.waitS)}
            </p>
          )}
          {cannotBuffer && (
            <p className="status" data-testid="nas-buffer-unavailable">
              {BUFFER_FAILED_COPY}
            </p>
          )}
          {plan?.kind === 'too-big' && (
            <p className="status" data-testid="nas-buffer-too-big">
              {tooBigCopy(plan.canHoldBytes, plan.bytes)}
            </p>
          )}
          <div className="preflight-actions">
            {plan?.kind === 'ask' && (
              <button type="button" data-testid="nas-wait" disabled={!manifest || opening !== 'idle'} onClick={() => waitFor(plan.bytes)}>
                Wait
              </button>
            )}
            <button
              type="button"
              data-testid="nas-play"
              disabled={!manifest || opening !== 'idle' || estimating}
              onClick={() => (plan?.kind === 'silent' ? waitFor(plan.bytes) : plan?.kind === 'ask' || plan?.kind === 'too-big' ? playWithPauses() : play())}
            >
              {plan?.kind === 'ask' || plan?.kind === 'too-big' || cannotBuffer ? 'Play now with pauses' : 'Play'}
            </button>
            {plan?.kind === 'ask' && (
              <button type="button" disabled>
                Lower quality (coming later)
              </button>
            )}
            <button type="button" onClick={onCancel}>
              Back
            </button>
          </div>
        </>
      )}
    </section>
  );
}
