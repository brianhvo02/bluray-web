import type { Telemetry } from '../engine/protocol';
import { chooseMemoryProfile } from '../ui/memory-profile';
import { AudioOutput } from './audio-output';
import { PlayerController } from './player-controller';

export function createController(): PlayerController {
  const params = new URLSearchParams(location.search);
  // Test-only (E2E): ?bdjfail=1 names the engine worker so that it injects an unreadable class library (engine/worker.ts).
  // (the options stay an object literal with a literal type: Vite reads it to bundle the worker as a module)
  const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module', name: params.has('bdjfail') ? 'bluray-engine:bdjfail' : 'bluray-engine' });
  const controller = new PlayerController(worker, new AudioOutput());
  controller.setMemoryProfile(chooseMemoryProfile({
    search: location.search,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
    platform: navigator.platform,
  }));
  if (params.has('telemetry')) {
    const target = window as unknown as { __blurayTelemetry?: Telemetry | null };
    controller.subscribe(() => {
      target.__blurayTelemetry = controller.getSnapshot().telemetry;
    });
  }
  return controller;
}
