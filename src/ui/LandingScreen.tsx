import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from 'react';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { checkCapabilities, showStorageHint } from './capabilities';
import { LibraryScreen } from './nas/LibraryScreen';
import { PairScreen } from './nas/PairScreen';
import { TitleLibrary } from './nas/TitleLibrary';
import { NAS_MESSAGES, type NasClient } from './nas/nas-client';
import type { NasPairing } from './nas/nas-store';
import { collectFromDirectoryHandle, collectFromFileList, discFromDataTransfer } from './disc-input';
import { listServerDiscs, serverDiscSpec, serverLinkFromLocation, type ServerDisc, type ServerLink } from './disc-server';
import type { RemoteDiscSpec } from '../engine/disc/disc-spec';
import { listRecentDiscs, reopenRecentDisc, saveRecentDisc, type RecentDisc } from './recent-discs';

/** A pick that takes longer than this to hand over its files is being copied (iOS copies every picked file first). */
const COPY_NOTICE_DELAY_MS = 1500;

interface LandingScreenProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
  readonly nas: NasClient;
  /** A code from a `?pair=` link: the pair screen opens with it filled in. */
  readonly pairCode?: string;
}

export function LandingScreen({ controller, snapshot, nas, pairCode }: LandingScreenProps): ReactElement {
  const [capabilities] = useState(() => checkCapabilities());
  const [storageHint] = useState(() => showStorageHint(capabilities.canRememberDiscs));
  const [recent, setRecent] = useState<RecentDisc[]>([]);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // tools/disc-server: ?disc=<disc API base>&token= or ?token= (spec 2026-10-17 §4.5). Each disc's manifest is fetched
  // before its button is enabled, so the tap opens it at once (audio starts inside the tap), as the NAS pre-flight does.
  const [serverLink] = useState<ServerLink | null>(() => serverLinkFromLocation(window.location.href));
  const [serverDiscs, setServerDiscs] = useState<ServerDisc[] | null>(null);
  const [serverSpecs, setServerSpecs] = useState<ReadonlyMap<string, RemoteDiscSpec | string>>(new Map());
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverLink) return;
    let cancelled = false;
    listServerDiscs(serverLink).then(
      (discs) => {
        if (cancelled) return;
        setServerDiscs(discs);
        for (const disc of discs) {
          serverDiscSpec(disc, serverLink.token).then(
            (spec) => !cancelled && setServerSpecs((m) => new Map(m).set(disc.base, spec)),
            (err: unknown) => !cancelled && setServerSpecs((m) => new Map(m).set(disc.base, err instanceof Error ? err.message : String(err))),
          );
        }
      },
      (err: unknown) => !cancelled && setServerError(`The disc server could not be reached: ${err instanceof Error ? err.message : String(err)}`),
    );
    return () => {
      cancelled = true;
    };
  }, [serverLink]);
  /** The folder picker is open or handing over its files (the input fallback); the copy notice shows after COPY_NOTICE_DELAY_MS. */
  const [awaitingFiles, setAwaitingFiles] = useState(false);
  const [copyNotice, setCopyNotice] = useState(false);

  useEffect(() => {
    listRecentDiscs().then(setRecent, () => setRecent([]));
  }, []);

  /** undefined while loading; null when this device isn't paired. */
  const [pairing, setPairing] = useState<NasPairing | null | undefined>(undefined);
  const [pairRequested, setPairRequested] = useState(pairCode !== undefined);
  /**
   * The NAS view: closed, asking `me` whether the title library is open to this device, the library (with whether this
   * device is an owner), or the folder browser. A guest while the gate is closed gets the folders, with no notice.
   */
  const [nasView, setNasView] = useState<{ kind: 'closed' | 'checking' | 'folders' } | { kind: 'titles'; owner: boolean }>({ kind: 'closed' });
  const browsing = nasView.kind !== 'closed';
  const setBrowsing = (open: boolean): void => {
    if (!open) {
      setNasView({ kind: 'closed' });
      return;
    }
    setNasView({ kind: 'checking' });
    nas.me().then(
      (me) => setNasView((v) => (v.kind !== 'checking' ? v : me.titleLibrary ? { kind: 'titles', owner: me.owner } : { kind: 'folders' })),
      // an older NAS without `me`, or any failure: the folder browser shows what is wrong, if anything
      () => setNasView((v) => (v.kind === 'checking' ? { kind: 'folders' } : v)),
    );
  };
  const showFolders = useCallback(() => setNasView({ kind: 'folders' }), []);
  const closeNas = useCallback(() => setNasView({ kind: 'closed' }), []);
  const loadPairing = (): void => {
    nas.pairing().then(setPairing, () => setPairing(null));
  };
  useEffect(loadPairing, [nas]);
  // A NAS call that finds this device revoked clears the pairing: say so and show the code field again.
  useEffect(
    () =>
      nas.onUnpaired(() => {
        setBrowsing(false);
        setLocalError(NAS_MESSAGES.unpaired);
        loadPairing();
      }),
    [nas],
  );
  const forgetNas = (): void => {
    setPairRequested(false);
    setBrowsing(false);
    nas.forget().then(loadPairing, (err: unknown) => setLocalError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const cancel = (): void => setAwaitingFiles(false);
    input.addEventListener('cancel', cancel);
    return () => input.removeEventListener('cancel', cancel);
  }, []);

  useEffect(() => {
    if (!awaitingFiles) {
      setCopyNotice(false);
      return;
    }
    const timer = window.setTimeout(() => setCopyNotice(true), COPY_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [awaitingFiles]);

  const run = (task: Promise<void>): void => {
    task.catch((err: unknown) => setLocalError(err instanceof Error ? err.message : String(err)));
  };

  const openHandle = async (handle: FileSystemDirectoryHandle): Promise<void> => {
    controller.open(await collectFromDirectoryHandle(handle));
    try {
      await saveRecentDisc(handle);
      setRecent(await listRecentDiscs());
    } catch {
      // The recent-discs list is a convenience; failing to update it must not block playback.
    }
  };

  const pickFolder = async (): Promise<void> => {
    let handle: FileSystemDirectoryHandle | undefined;
    try {
      handle = await window.showDirectoryPicker?.({ id: 'bluray-disc', mode: 'read' });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      throw err;
    }
    if (handle) await openHandle(handle);
  };

  const onPickFolder = (): void => {
    setLocalError(null);
    controller.startAudio(); // must happen inside the click gesture
    if (!capabilities.canPickDirectory) {
      setAwaitingFiles(true);
      inputRef.current?.click();
      return;
    }
    run(pickFolder());
  };

  const onInput = (e: ChangeEvent<HTMLInputElement>): void => {
    setAwaitingFiles(false);
    setLocalError(null);
    const files = e.target.files;
    if (files && files.length > 0) controller.open(collectFromFileList(files));
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    setLocalError(null);
    controller.startAudio();
    const pending = discFromDataTransfer(e.dataTransfer); // synchronous part must run inside the event
    run(
      pending.then(async (dropped) => {
        if (!dropped) {
          setLocalError('Drop the disc folder itself (the folder that contains BDMV).');
          return;
        }
        if (dropped.kind === 'entries') controller.open(dropped.entries);
        else await openHandle(dropped.handle);
      }),
    );
  };

  const onRecent = (disc: RecentDisc): void => {
    setLocalError(null);
    controller.startAudio();
    run(
      reopenRecentDisc(disc).then(async (handle) => {
        if (!handle) {
          setLocalError(`Permission to read "${disc.name}" was not granted.`);
          return;
        }
        await openHandle(handle);
      }),
    );
  };

  const onServerDisc = (spec: RemoteDiscSpec): void => {
    setLocalError(null);
    controller.openRemote(spec); // starts audio inside the tap; the server's token lasts the run, so there is no refresh
  };

  const error = localError ?? snapshot.error?.message ?? null;
  const nasWaiting = snapshot.engineState === 'loading' ? snapshot.notices.find((n) => n.code === 'nas-waiting') : undefined;
  const paired = pairing !== undefined && pairing !== null && !pairRequested;
  const errorPaths = localError ? [] : (snapshot.error?.paths ?? []);

  return (
    <main className="landing" data-testid="landing">
      <h1>Blu-ray Player</h1>
      {!capabilities.core.ok && (
        <div className="error-banner" role="alert">
          This browser is missing: {capabilities.core.missing.join(', ')}. Use Chrome, Edge, Safari or Firefox (desktop), or Chrome on Android.
        </div>
      )}
      <div
        className={`drop-zone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drop a decrypted Blu-ray folder here: the disc folder, or the BDMV folder inside it.</p>
        {capabilities.core.ok && !capabilities.bdj.ok && (
          <p className="hint" data-testid="bdj-capability-hint">
            BD-J (Java) menus can't run in this browser: it lacks {capabilities.bdj.missing.join(', ')}. Discs with them open to their playlists.
          </p>
        )}
        {storageHint && <p className="hint">On Safari, add the app to your Home Screen or Dock so your settings aren't cleared after 7 days without a visit.</p>}
        <button type="button" data-testid="open-folder" disabled={!capabilities.core.ok} onClick={onPickFolder}>
          Open disc folder
        </button>
        {/* webkitdirectory is rendered, not set in an effect: the input must pick folders from the moment it exists */}
        <input ref={inputRef} type="file" multiple hidden data-testid="folder-input" {...{ webkitdirectory: '' }} onChange={onInput} />
      </div>
      {serverLink && (
        <section className="recent server-discs" data-testid="server-discs">
          <h2>On the disc server</h2>
          {serverError && <p className="hint">{serverError}</p>}
          {serverDiscs?.length === 0 && <p className="hint">The server has no discs.</p>}
          {serverDiscs && serverDiscs.length > 0 && (
            <ul>
              {serverDiscs.map((disc) => {
                const spec = serverSpecs.get(disc.base);
                return (
                  <li key={disc.base}>
                    <button
                      type="button"
                      disabled={!capabilities.core.ok || typeof spec !== 'object'}
                      onClick={() => typeof spec === 'object' && onServerDisc(spec)}
                    >
                      {disc.name}
                    </button>
                    {typeof spec === 'string' && <p className="hint">{spec}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {copyNotice && (
        <p className="status" role="status" data-testid="copy-notice">
          Waiting for the files… On iPhone and iPad, Safari copies the whole folder before the player can read it, so a full disc can take an hour or more from a USB drive.
        </p>
      )}
      {snapshot.engineState === 'loading' && <p className="status">Reading disc…</p>}
      {nasWaiting && (
        <p className="status" role="status" data-testid="nas-waiting">
          {nasWaiting.message}
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert" data-testid="error">
          {error}
          {errorPaths.length > 0 && (
            <ul>
              {errorPaths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {pairing !== undefined &&
        (pairing === null || pairRequested ? (
          <PairScreen
            client={nas}
            initialCode={pairCode}
            onPaired={() => {
              setPairRequested(false);
              setLocalError(null);
              loadPairing();
            }}
          />
        ) : (
          <p className="status" data-testid="nas-paired">
            Paired with the NAS as {pairing.deviceName}.{' '}
            {!browsing && (
              <button
                type="button"
                data-testid="nas-open"
                onClick={() => {
                  setLocalError(null);
                  setBrowsing(true);
                }}
              >
                Open from NAS
              </button>
            )}{' '}
            <button type="button" data-testid="nas-forget" onClick={forgetNas}>
              Forget this NAS
            </button>
          </p>
        ))}
      {paired && nasView.kind === 'checking' && <p className="status">Loading…</p>}
      {paired && nasView.kind === 'titles' && <TitleLibrary nas={nas} controller={controller} owner={nasView.owner} onFolders={showFolders} onClose={closeNas} />}
      {paired && nasView.kind === 'folders' && <LibraryScreen nas={nas} controller={controller} onClose={closeNas} />}
      {capabilities.canRememberDiscs && recent.length > 0 && (
        <section className="recent">
          <h2>Recent discs</h2>
          <ul>
            {recent.map((disc) => (
              <li key={disc.id}>
                <button type="button" onClick={() => onRecent(disc)}>
                  {disc.name} <span className="recent-date">· {new Date(disc.openedAt).toLocaleDateString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
