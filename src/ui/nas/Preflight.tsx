import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { discKeyOf } from '../../engine/disc/disc-key';
import { DISC_CHANGED_MESSAGE } from '../../engine/disc/http-transport';
import type { ContinueItem, DiscEntry, DiscManifest, DiscPlaces } from '../../engine/disc/nas-api';
import type { BufferRequest, StartPoint } from '../../engine/protocol';
import type { PlayerController } from '../../player/player-controller';
import { BUFFER_FAILED_COPY, bufferPlan, playlistFacts, readAheadCacheBytes, storageRoom, tooBigCopy, waitCopy, watchBufferFailure, type BufferPlan } from './buffer-model';
import { discBadges, discFacts, formatSize, mainPlaylist, mainPlaylistId, openFailed, playlistOf, preflightLines, type DiscFacts } from './library-model';
import { nasDiscSpec } from './disc-spec';
import { NasHttpError, type NasClient } from './nas-client';
import { useNasRoute, type NasHistory } from './nas-history';
import type { NasRoute } from './nas-route';
import { noticeMissingStart } from './missing-start-notice';
import type { PlayingRoute } from './playing-route';
import { LOCAL_DEVICE_NAME, type LaunchSettings, type PlaceSaver } from '../place-saver';
import { pairingKey } from './nas-store';
import { ResumePrompt } from './ResumePrompt';
import { carriedSettings, playlistsOf, resumeOffer, startOver, type ResumeOffer } from './resume-model';

/** The disc to open: a folder listing's row, or a title's disc, whose size is only known from its manifest. */
export type PreflightDisc = Pick<DiscEntry, 'id' | 'name' | 'kind'> & { readonly sizeBytes: number | null };

interface PreflightProps {
  readonly nas: NasClient;
  readonly controller: PlayerController;
  readonly disc: PreflightDisc;
  /** An episode's playlist: the disc opens playing it (StartPoint), without running First Play. */
  readonly playlistId?: string;
  /** A play link's time in the playlist, where it starts (from the beginning past its end, ignored without a playlist). */
  readonly startTimeS?: number;
  /** From a Continue watching card: the place resumes without the question (Resume is the one way on). */
  readonly resume?: boolean;
  /** Play goes into the address bar as the disc's play route, which `playingRoute` then keeps current. */
  readonly history: NasHistory;
  readonly playingRoute: PlayingRoute;
  /** Saves the launched disc's place, here and on the NAS. */
  readonly places: PlaceSaver;
  /** Play is about to push the play route: the screen holding this pre-flight keeps it shown on that route. */
  readonly onLaunch?: () => void;
  /** Whether the disc is UHD, once its manifest has shown it (for the row's badge). */
  readonly onFacts: (discId: string, facts: DiscFacts) => void;
  readonly onCancel: () => void;
}

const LIBRARY: NasRoute = { kind: 'library', shelf: null, q: '' };
const NO_OFFER: ResumeOffer = { kind: 'none' };

/** Where a launch opens the disc (undefined: as the disc starts), and the settings the player applies once it plays. */
interface Launch {
  readonly start: StartPoint | undefined;
  readonly settings: LaunchSettings | undefined;
}

/** A disc gone (or replaced) since its folder was listed answers 404 disc-changed. */
const message = (err: unknown): string =>
  err instanceof NasHttpError && err.code === 'disc-changed' ? DISC_CHANGED_MESSAGE : err instanceof Error ? err.message : String(err);

/**
 * ?bufferask=1 is test-only (E2E): every wait asks first (no silent buffering), so `ask` shows with a short synthetic disc.
 * Read once at load, from the address the app opened with: the NAS screens' paths leave the query behind.
 */
const ASK_EVERY_WAIT = new URLSearchParams(globalThis.location?.search ?? '').get('bufferask') === '1';

/**
 * Before a NAS disc plays: its manifest, this connection's throughput against the disc's peak rate, and Play. When the
 * connection is slower than the main title (buffer first), Play buffers ahead first: silently for a short wait, else
 * after asking (Wait, or Play now with pauses); a device that can't hold the wait offers pauses.
 */
export function Preflight({ nas, controller, disc, playlistId, startTimeS, resume = false, history, playingRoute, places, onLaunch, onFacts, onCancel }: PreflightProps): ReactElement {
  const route = useNasRoute(history);
  const [manifest, setManifest] = useState<DiscManifest | null>(null);
  /** The disc's link key, from its manifest: `f.<fingerprint>`, else `d.<disc id>`. */
  const discKey = useMemo(() => (manifest ? discKeyOf(disc.id, manifest.files) : null), [manifest, disc.id]);
  /** Whether the address bar is this disc's play route (a link, or Play pressed here). */
  const onPlayRoute = route?.kind === 'play' && (route.discKey === discKey || route.discKey === `d.${disc.id}`);
  const [facts, setFacts] = useState<DiscFacts | null>(null);
  /** This person's places on the disc, from the NAS (never this device's store: a shared device has others'); undefined while asked. */
  const [stored, setStored] = useState<DiscPlaces | null | undefined>(undefined);
  /** The Continue watching list, asked only for a playlist with no place of its own (an Up next card's settings); undefined while asked. */
  const [items, setItems] = useState<readonly ContinueItem[] | null | undefined>(undefined);
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
  /**
   * Releases the wait for this open's start result (noticeMissingStart). The wait outlives this pre-flight, which
   * unmounts as the disc's playlists arrive, before the engine reports whether it could start there; it is let go when the launch is
   * abandoned, and noticeMissingStart lets go by itself when another disc opens or this one closes.
   */
  const releaseWait = useRef<(() => void) | null>(null);
  /** Bumped when a launch is abandoned, so its pending open (discBase, session) is dropped. */
  const launch = useRef(0);
  /** A launch from Play until it is abandoned or fails: the disc is opening, or open, on this play route. */
  const launched = useRef(false);
  /** Gives up this launch: its pending open, its playlist wait, the address bar's following, and the disc. */
  const abandon = (): void => {
    if (!launched.current) return;
    launched.current = false;
    launch.current++;
    releaseWait.current?.();
    releaseWait.current = null;
    playingRoute.stop();
    controller.closeDisc();
  };
  const abandonRef = useRef(abandon);
  abandonRef.current = abandon;
  /** The keys of this disc's play route, for a check at unmount. */
  const routeKeys = useRef<readonly string[]>([]);
  routeKeys.current = discKey === null ? [`d.${disc.id}`] : [discKey, `d.${disc.id}`];
  // Unmounted while launched: the disc's playlists arrived (the address bar still on its play route), which keeps it;
  // or Back went elsewhere while it opened (a link's pre-flight unmounts with its route), which gives it up.
  useEffect(
    () => () => {
      const r = history.route();
      if (r?.kind !== 'play' || !routeKeys.current.includes(r.discKey)) abandonRef.current();
    },
    [history],
  );
  useEffect(() => {
    if ((opening === 'launched' || opening === 'buffering') && engineFailed) {
      launched.current = false;
      setOpening('idle');
      playingRoute.stop();
    }
  }, [opening, engineFailed, playingRoute]);
  // A link with the disc id's key gets the fingerprint's once the manifest shows it: the link a copy or a move keeps.
  useEffect(() => {
    if (route?.kind === 'play' && discKey !== null && route.discKey === `d.${disc.id}` && route.discKey !== discKey) history.replace({ ...route, discKey });
  }, [route, discKey, disc.id, history]);
  // Back (or Forward) off the play route while the disc opens: it is closed. The screen holding this pre-flight closes
  // it on leaving the play route (and a link's pre-flight unmounts with it), so nothing navigates again here.
  const leftRoute = opening !== 'idle' && !onPlayRoute;
  useEffect(() => {
    if (!leftRoute) return;
    abandonRef.current();
    setOpening('idle');
  }, [leftRoute]);

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

  // The places once the disc's key is known. A failed request is no place: playback is never held up by it.
  useEffect(() => {
    if (discKey === null) return;
    let live = true;
    setStored(undefined);
    nas.playbackPlaces(discKey).then(
      (p) => live && setStored(p),
      () => live && setStored(null),
    );
    return () => {
      live = false;
    };
  }, [nas, discKey]);
  /** A play link's own time names where to play: no question then, unless it comes from a Continue watching card. */
  const offers = startTimeS === undefined || resume;
  const playlists = useMemo(() => (manifest ? playlistsOf(manifest) : null), [manifest]);
  const offer: ResumeOffer = useMemo(
    () => (offers && stored !== undefined && playlists !== null ? resumeOffer(stored, playlistId ?? null, playlists) : NO_OFFER),
    [offers, stored, playlistId, playlists],
  );
  /** A playlist with no place to resume starts with settings carried over: an Up next card's, else the disc's defaults. */
  const wantsCarried = playlistId !== undefined && stored !== undefined && offer.kind === 'none';
  useEffect(() => {
    if (!wantsCarried) return;
    let live = true;
    nas.continueWatching().then(
      (list) => live && setItems(list),
      () => live && setItems(null),
    );
    return () => {
      live = false;
    };
  }, [nas, wantsCarried]);
  const placesReady = stored !== undefined && (!wantsCarried || items !== undefined);
  /** What plays: the requested playlist, else the place offered. */
  const launchPlaylist = playlistId ?? (offer.kind === 'none' ? undefined : offer.place.playlistId);

  /**
   * The length and bytes of what plays (the episode's playlist, else the main title's) against this connection; null
   * until both are known (or with no playlist).
   */
  const need = useMemo(() => {
    const playlist = manifest && ((launchPlaylist !== undefined ? playlistOf(manifest, launchPlaylist) : null) ?? mainPlaylist(manifest));
    if (!playlist || typeof mbps !== 'number') return null;
    const sizes = new Map(manifest.files.map((f) => [f.path, f.size]));
    return { ...playlistFacts(playlist.playItems, sizes), connectionMbps: mbps };
  }, [manifest, mbps, launchPlaylist]);
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
    need === null ? (mbps === null ? { kind: 'play' } : null) : keepsUp ? { kind: 'play' } : cannotBuffer || quota === undefined ? null : bufferPlan({ ...need, quotaBytes: quota, ...(ASK_EVERY_WAIT ? { silentBelowS: 0 } : {}) });

  /** Play: the requested playlist (at a link's time) or the disc as it starts, with any settings carried over. */
  const plainLaunch = (): Launch => {
    // A playlist (an episode, a play link) opens the disc there, in the engine: First Play never runs first.
    const start: StartPoint | undefined = playlistId === undefined ? undefined : { playlistId, timeUs: (startTimeS ?? 0) * 1e6, hdmv: null, playback: null };
    const carried = playlistId === undefined ? null : carriedSettings(items ?? null, disc.id, playlistId, stored ?? null);
    return { start, settings: carried ? { settings: carried, byLanguage: true } : undefined };
  };
  /** Resume at: the place's own playlist, time and registers (resumeStart), with its settings. */
  const resumeLaunch = (): Launch => (offer.kind === 'ask' ? { start: offer.start, settings: { settings: offer.place.settings, byLanguage: false } } : plainLaunch());
  /** Start from beginning: the place's playlist from 0, with the same settings. */
  const startOverLaunch = (): Launch => (offer.kind === 'none' ? plainLaunch() : { start: startOver(offer.place), settings: { settings: offer.place.settings, byLanguage: false } });

  /** `hold`: the disc opens once the cache holds the target (Wait); otherwise at once, its fill going on behind it. */
  const play = (launchWith: Launch, bufferFirst?: BufferRequest, hold = true): void => {
    if (!manifest || discKey === null) return;
    const { start } = launchWith;
    controller.startAudio(); // inside the click gesture
    setOpening('starting');
    setError(null);
    // The play route: pushed from a title or folder, so Back returns there; a link is already on it.
    playingRoute.start(discKey);
    launched.current = true;
    if (!onPlayRoute) {
      onLaunch?.();
      history.push({ kind: 'play', discKey, playlistId: start?.playlistId ?? null, timeS: null, resume: false });
    }
    const id = ++launch.current;
    Promise.all([nas.discBase(disc.id), nas.session(), nas.pairing()]).then(
      ([base, session, pairing]) => {
        if (id !== launch.current) return;
        // The engine asks again only after the NAS refused the token it has, so that one is never handed back.
        let token = session.token;
        const { spec, release } = nasDiscSpec(base, token, manifest, nas.discFetch);
        controller.openRemote(spec, () => nas.freshSession(token).then((s) => (token = s.token)), release, bufferFirst, start);
        places.begin(
          {
            discKey, discId: disc.id, remote: true, chosen: start?.playlistId ?? null, mainPlaylistId: mainPlaylistId(manifest),
            deviceName: pairing?.deviceName ?? LOCAL_DEVICE_NAME, pairing: pairing ? pairingKey(pairing) : null,
          },
          launchWith.settings,
        );
        if (bufferFirst && !hold) controller.cancelBuffer(); // play now: the queued open doesn't wait for its fill
        releaseWait.current?.();
        releaseWait.current = start === undefined ? null : noticeMissingStart(controller);
        if (bufferFirst) watchBufferFailure(controller); // for as long as this disc is open, past this screen
        setOpening(bufferFirst && hold ? 'buffering' : 'launched');
      },
    ).catch((err: unknown) => {
      if (id !== launch.current) return;
      launched.current = false;
      playingRoute.stop();
      setOpening('idle');
      setError(message(err));
    });
  };

  /** Buffer first: the bytes the plan holds ahead, from where what plays starts. */
  const request = (bytes: number, launchWith: Launch): BufferRequest => {
    const start = launchWith.start;
    return { fromSeconds: start ? Math.floor(start.timeUs / 1e6) : 0, targetBytes: Math.ceil(bytes), ...(start ? { playlistId: start.playlistId } : {}) };
  };
  const waitFor = (bytes: number, launchWith: Launch): void => play(launchWith, request(bytes, launchWith));
  /**
   * Play now with pauses: at once, with a fill ahead of playback (capped at the plan's lead, or what the device can
   * hold) for fewer pauses; without a cache, as before.
   */
  const playWithPauses = (launchWith: Launch): void => {
    const lead = plan?.kind === 'ask' ? plan.bytes : plan?.kind === 'too-big' ? plan.canHoldBytes : 0;
    if (lead > 0) play(launchWith, request(lead, launchWith), false);
    else play(launchWith);
  };
  /** Play (or Resume, or Start from beginning) as the buffer plan says: silently buffered, with pauses, or at once. */
  const go = (launchWith: Launch): void =>
    plan?.kind === 'silent' ? waitFor(plan.bytes, launchWith) : plan?.kind === 'ask' || plan?.kind === 'too-big' ? playWithPauses(launchWith) : play(launchWith);
  const stopWaiting = (): void => {
    abandon(); // the engine drops the disc unopened
    setOpening('idle');
  };
  /** Back: off the play route through the history (to the screen Play came from, else the library), else closed here. */
  const cancel = (): void => (onPlayRoute ? history.back(LIBRARY) : onCancel());
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
          {offer.kind !== 'none' && (
            <ResumePrompt
              place={offer.place}
              changed={offer.kind === 'changed'}
              resumeOnly={resume}
              disabled={!manifest || opening !== 'idle' || estimating}
              nowMs={Date.now()}
              onResume={() => go(resumeLaunch())}
              onStartOver={() => go(startOverLaunch())}
            />
          )}
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
              <button type="button" data-testid="nas-wait" disabled={!manifest || opening !== 'idle' || !placesReady} onClick={() => waitFor(plan.bytes, offer.kind === 'ask' ? resumeLaunch() : offer.kind === 'changed' ? startOverLaunch() : plainLaunch())}>
                Wait
              </button>
            )}
            {offer.kind === 'none' && (
              <button
                type="button"
                data-testid="nas-play"
                disabled={!manifest || opening !== 'idle' || estimating || !placesReady}
                onClick={() => go(plainLaunch())}
              >
                {plan?.kind === 'ask' || plan?.kind === 'too-big' || cannotBuffer ? 'Play now with pauses' : 'Play'}
              </button>
            )}
            {plan?.kind === 'ask' && (
              <button type="button" disabled>
                Lower quality (coming later)
              </button>
            )}
            <button type="button" onClick={cancel}>
              Back
            </button>
          </div>
        </>
      )}
    </section>
  );
}
