import type { Telemetry } from '../engine/protocol';
import { AudioOutput } from './audio-output';
import { PlayerController } from './player-controller';

export function createController(): PlayerController {
  const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
  const controller = new PlayerController(worker, new AudioOutput());
  if (new URLSearchParams(location.search).has('telemetry')) {
    const target = window as unknown as { __blurayTelemetry?: Telemetry | null };
    controller.subscribe(() => {
      target.__blurayTelemetry = controller.getSnapshot().telemetry;
    });
  }
  return controller;
}
