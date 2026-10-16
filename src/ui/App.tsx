import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { createController } from '../player/create-controller';
import type { PlayerController } from '../player/player-controller';
import { LandingScreen } from './LandingScreen';
import { PlayerScreen } from './PlayerScreen';
import { idbShaderLibrary } from './shader-library';
import { ShaderModel } from './shader-model';

let sharedController: PlayerController | null = null;

function getController(): PlayerController {
  sharedController ??= createController();
  return sharedController;
}

let sharedShaders: ShaderModel | null = null;

function getShaderModel(controller: PlayerController): ShaderModel {
  sharedShaders ??= new ShaderModel(idbShaderLibrary(), (set) => controller.setShaderSet(set));
  return sharedShaders;
}

export function App(): ReactElement {
  const [controller] = useState(getController);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [shaders] = useState(() => getShaderModel(controller));
  const shaderState = useSyncExternalStore(shaders.subscribe, shaders.getSnapshot);
  useEffect(() => {
    // Without IndexedDB the menu still opens, but sets cannot be chosen that session (docs/known-issues.md).
    shaders.load().catch((e) => console.error('shader library failed to load', e));
  }, [shaders]);
  return (
    <div className="app" data-testid="app">
      {snapshot.playlists.length === 0 ? (
        <LandingScreen controller={controller} snapshot={snapshot} />
      ) : (
        <PlayerScreen controller={controller} snapshot={snapshot} shaderModel={shaders} shaderState={shaderState} />
      )}
    </div>
  );
}
