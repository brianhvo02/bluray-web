import { useState, useSyncExternalStore, type ReactElement } from 'react';
import { createController } from '../player/create-controller';
import type { PlayerController } from '../player/player-controller';
import { LandingScreen } from './LandingScreen';
import { PlayerScreen } from './PlayerScreen';

let sharedController: PlayerController | null = null;

function getController(): PlayerController {
  sharedController ??= createController();
  return sharedController;
}

export function App(): ReactElement {
  const [controller] = useState(getController);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return (
    <div className="app" data-testid="app">
      {snapshot.playlists.length === 0 ? (
        <LandingScreen controller={controller} snapshot={snapshot} />
      ) : (
        <PlayerScreen controller={controller} snapshot={snapshot} />
      )}
    </div>
  );
}
