import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { createController } from '../player/create-controller';
import type { PlayerController } from '../player/player-controller';
import { PlatformSession } from '../player/platform-session';
import { LandingScreen } from './LandingScreen';
import { NasClient } from './nas/nas-client';
import { idbNasStore } from './nas/nas-store';
import { PlayerScreen } from './PlayerScreen';
import { idbShaderLibrary } from './shader-library';
import { ShaderModel } from './shader-model';
import { isWaitingWorker, reloadAction, shouldPromptUpdate } from './update-prompt';

let sharedController: PlayerController | null = null;

function getController(): PlayerController {
  sharedController ??= createController();
  return sharedController;
}

let sharedNas: NasClient | null = null;

function getNasClient(): NasClient {
  sharedNas ??= new NasClient({
    fetch: (input, init) => fetch(input, init),
    subtle: crypto.subtle,
    store: idbNasStore(),
    now: Date.now,
    rendezvousUrl: import.meta.env.VITE_RENDEZVOUS_URL as string | undefined,
  });
  return sharedNas;
}

let pairCodeTaken = false;
let takenPairCode: string | undefined;

/** The code of a `?pair=<code>` link, taken out of the address bar (once) so a reload doesn't pair again. */
function takePairCode(): string | undefined {
  if (pairCodeTaken) return takenPairCode;
  pairCodeTaken = true;
  const url = new URL(window.location.href);
  takenPairCode = url.searchParams.get('pair') ?? undefined;
  if (takenPairCode !== undefined) {
    url.searchParams.delete('pair');
    window.history.replaceState(window.history.state, '', url);
  }
  return takenPairCode;
}

let sharedShaders: ShaderModel | null = null;

function getShaderModel(controller: PlayerController): ShaderModel {
  sharedShaders ??= new ShaderModel(idbShaderLibrary(), (set) => controller.setShaderSet(set));
  return sharedShaders;
}

/** The new service worker waiting to take over after a deploy, if any. */
function useWaitingWorker(): ServiceWorker | null {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    const container = navigator.serviceWorker as ServiceWorkerContainer | undefined;
    if (!container) return;
    let cancelled = false;
    let registration: ServiceWorkerRegistration | null = null;
    // Only an update counts: the first install has no controller and takes over on its own.
    const track = (worker: ServiceWorker | null): void => {
      if (!worker || !container.controller) return;
      const check = (): void => {
        if (cancelled) return;
        if (isWaitingWorker(worker.state)) setWaiting(worker);
        else setWaiting((current) => (current === worker ? null : current));
      };
      check();
      worker.addEventListener('statechange', check);
    };
    const onUpdateFound = (): void => track(registration?.installing ?? null);
    void container.ready.then((reg) => {
      if (cancelled) return;
      registration = reg;
      track(reg.waiting ?? reg.installing);
      reg.addEventListener('updatefound', onUpdateFound);
    });
    return () => {
      cancelled = true;
      registration?.removeEventListener('updatefound', onUpdateFound);
    };
  }, []);
  return waiting;
}

function UpdatePrompt({ worker }: { worker: ServiceWorker }): ReactElement {
  const reload = (): void => {
    if (reloadAction(worker.state) === 'reload') {
      window.location.reload();
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    worker.postMessage({ type: 'skip-waiting' });
  };
  return (
    <div className="update-prompt" role="status" data-testid="update-prompt">
      A new version is ready.{' '}
      <button type="button" onClick={reload}>
        Reload
      </button>
    </div>
  );
}

export function App(): ReactElement {
  const [controller] = useState(getController);
  const [nas] = useState(getNasClient);
  const [pairCode] = useState(takePairCode);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const session = new PlatformSession(
      { wakeLock: navigator.wakeLock, mediaSession: navigator.mediaSession, MediaMetadata: globalThis.MediaMetadata },
      controller,
    );
    return () => session.dispose();
  }, [controller]);
  const [shaders] = useState(() => getShaderModel(controller));
  const shaderState = useSyncExternalStore(shaders.subscribe, shaders.getSnapshot);
  useEffect(() => {
    // Without IndexedDB the menu still opens, but sets cannot be chosen that session (docs/known-issues.md).
    shaders.load().catch((e) => console.error('shader library failed to load', e));
  }, [shaders]);
  const waitingWorker = useWaitingWorker();
  return (
    <div className="app" data-testid="app">
      {waitingWorker && shouldPromptUpdate({ waiting: true, engineState: snapshot.engineState }) && <UpdatePrompt worker={waitingWorker} />}
      {snapshot.playlists.length === 0 ? (
        <LandingScreen controller={controller} snapshot={snapshot} nas={nas} pairCode={pairCode} />
      ) : (
        <PlayerScreen controller={controller} snapshot={snapshot} shaderModel={shaders} shaderState={shaderState} nas={nas} />
      )}
    </div>
  );
}
