import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from 'react';
import type { PlayerController, PlayerSnapshot } from '../player/player-controller';
import { checkCapabilities } from './capabilities';
import { collectFromDirectoryHandle, collectFromFileList, discFromDataTransfer } from './disc-input';
import { listRecentDiscs, reopenRecentDisc, saveRecentDisc, type RecentDisc } from './recent-discs';

interface LandingScreenProps {
  readonly controller: PlayerController;
  readonly snapshot: PlayerSnapshot;
}

export function LandingScreen({ controller, snapshot }: LandingScreenProps): ReactElement {
  const [capabilities] = useState(() => checkCapabilities());
  const [recent, setRecent] = useState<RecentDisc[]>([]);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.setAttribute('webkitdirectory', '');
    listRecentDiscs().then(setRecent, () => setRecent([]));
  }, []);

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
      inputRef.current?.click();
      return;
    }
    run(pickFolder());
  };

  const onInput = (e: ChangeEvent<HTMLInputElement>): void => {
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

  const error = localError ?? snapshot.error?.message ?? null;
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
        <button type="button" data-testid="open-folder" disabled={!capabilities.core.ok} onClick={onPickFolder}>
          Open disc folder
        </button>
        <input ref={inputRef} type="file" multiple hidden data-testid="folder-input" onChange={onInput} />
      </div>
      {snapshot.engineState === 'loading' && <p className="status">Reading disc…</p>}
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
