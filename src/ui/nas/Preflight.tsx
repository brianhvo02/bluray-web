import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { DISC_CHANGED_MESSAGE } from '../../engine/disc/http-transport';
import type { DiscEntry, DiscManifest } from '../../engine/disc/nas-api';
import type { PlayerController } from '../../player/player-controller';
import { discBadges, discFacts, formatSize, openFailed, preflightLines, type DiscFacts } from './library-model';
import { NasHttpError, type NasClient } from './nas-client';

interface PreflightProps {
  readonly nas: NasClient;
  readonly controller: PlayerController;
  readonly disc: DiscEntry;
  /** Whether the disc is UHD, once its manifest has shown it (for the row's badge). */
  readonly onFacts: (discId: string, facts: DiscFacts) => void;
  readonly onCancel: () => void;
}

/** A disc gone (or replaced) since its folder was listed answers 404 disc-changed. */
const message = (err: unknown): string =>
  err instanceof NasHttpError && err.code === 'disc-changed' ? DISC_CHANGED_MESSAGE : err instanceof Error ? err.message : String(err);

/** Before a NAS disc plays: its manifest, this connection's throughput against the disc's peak rate, and Play. */
export function Preflight({ nas, controller, disc, onFacts, onCancel }: PreflightProps): ReactElement {
  const [manifest, setManifest] = useState<DiscManifest | null>(null);
  const [facts, setFacts] = useState<DiscFacts | null>(null);
  /** undefined while probing; null when there is no measurement (no clip to probe, or it failed). */
  const [mbps, setMbps] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** 'launched' once the engine opens the disc: an open that fails there (shown as the player's error) ends it. */
  const [opening, setOpening] = useState<'idle' | 'starting' | 'launched'>('idle');
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const engineFailed = openFailed(snapshot);
  useEffect(() => {
    if (opening === 'launched' && engineFailed) setOpening('idle');
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

  const play = (): void => {
    if (!manifest) return;
    controller.startAudio(); // inside the click gesture
    setOpening('starting');
    setError(null);
    Promise.all([nas.discBase(disc.id), nas.session()]).then(
      ([base, session]) => {
        controller.openRemote({ kind: 'remote', base, token: session.token, manifest }, () => nas.session().then((s) => s.token));
        setOpening('launched');
      },
    ).catch((err: unknown) => {
      setOpening('idle');
      setError(message(err));
    });
  };

  const lines = preflightLines(mbps ?? null, facts?.peakMbps ?? null);
  const badges = discBadges(disc, facts?.uhd);

  return (
    <section className="preflight" data-testid="nas-preflight">
      <h3>{disc.name}</h3>
      <p className="library-meta">
        {formatSize(disc.sizeBytes)}
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
      <div className="preflight-actions">
        <button type="button" data-testid="nas-play" disabled={!manifest || opening !== 'idle'} onClick={play}>
          Play
        </button>
        <button type="button" onClick={onCancel}>
          Back
        </button>
      </div>
    </section>
  );
}
