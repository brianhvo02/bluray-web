import { useCallback, useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { createController } from '../player/create-controller';
import type { PlayerController } from '../player/player-controller';
import { PlatformSession } from '../player/platform-session';
import { LandingScreen } from './LandingScreen';
import { NasClient } from './nas/nas-client';
import { getNasHistory, useNasRoute } from './nas/nas-history';
import { idbNasStore } from './nas/nas-store';
import { PlayingRoute } from './nas/playing-route';
import { PlaceSaver } from './place-saver';
import { placeMinDurationUs } from './place-model';
import { idbPlaceStore } from './place-store';
import { PlayerScreen } from './PlayerScreen';
import { TOUCH_LOG, TouchLog } from './TouchLog';
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

let sharedPlaces: PlaceSaver | null = null;

function getPlaceSaver(controller: PlayerController, nas: NasClient): PlaceSaver {
  sharedPlaces ??= new PlaceSaver({
    store: idbPlaceStore(),
    nas,
    readPlace: () => controller.readPlace(),
    discOpens: () => controller.discOpens,
    nowMs: Date.now,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    // ?placemin=<seconds> is test-only: shorter playlists make places
    minDurationUs: placeMinDurationUs(window.location.search),
  });
  return sharedPlaces;
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
  // Spent once paired (or the NAS forgotten), so the landing screen shown again after a disc closes doesn't ask again.
  const [pairCode, setPairCode] = useState(takePairCode);
  const spendPairCode = useCallback(() => setPairCode(undefined), []);
  const [history] = useState(getNasHistory);
  // Kept subscribed for the app's life, so the history sees every popstate (its direction drives focus).
  useNasRoute(history);
  const [playingRoute] = useState(() => new PlayingRoute(history, () => performance.now()));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const session = new PlatformSession(
      { wakeLock: navigator.wakeLock, mediaSession: navigator.mediaSession, MediaMetadata: globalThis.MediaMetadata },
      controller,
    );
    return () => session.dispose();
  }, [controller]);
  const [places] = useState(() => getPlaceSaver(controller, nas));
  useEffect(() => {
    // Spec §6.2: the place is saved as the page is hidden or goes away (over HTTPS with keepalive), and places
    // waiting on this device go out whenever the NAS answers again.
    const hidden = (): void => {
      if (document.visibilityState === 'hidden') void places.flushNow({ keepalive: true });
    };
    const leaving = (): void => void places.flushNow({ keepalive: true });
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    const offSession = nas.onSession(() => void places.drainOutbox());
    // a new pairing (another NAS or person), a forgotten one, or one the NAS revoked: what waits isn't theirs
    const offPairing = nas.onPairingChange(() => void places.pairingChanged());
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
      offSession();
      offPairing();
    };
  }, [places, nas]);
  const [shaders] = useState(() => getShaderModel(controller));
  const shaderState = useSyncExternalStore(shaders.subscribe, shaders.getSnapshot);
  useEffect(() => {
    // Without IndexedDB the menu still opens, but sets cannot be chosen that session (docs/known-issues.md).
    shaders.load().catch((e) => console.error('shader library failed to load', e));
  }, [shaders]);
  const waitingWorker = useWaitingWorker();
  return (
    <div className="app" data-testid="app">
      {TOUCH_LOG && <TouchLog />}
      {waitingWorker && shouldPromptUpdate({ waiting: true, engineState: snapshot.engineState }) && <UpdatePrompt worker={waitingWorker} />}
      {snapshot.playlists.length === 0 ? (
        <LandingScreen controller={controller} snapshot={snapshot} nas={nas} places={places} history={history} playingRoute={playingRoute} pairCode={pairCode} onPairCodeSpent={spendPairCode} />
      ) : (
        <PlayerScreen
          controller={controller}
          snapshot={snapshot}
          shaderModel={shaders}
          shaderState={shaderState}
          nas={nas}
          places={places}
          history={history}
          playingRoute={playingRoute}
        />
      )}
    </div>
  );
}
