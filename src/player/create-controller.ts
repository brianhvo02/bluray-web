import type { Telemetry } from '../engine/protocol';
import { chooseMemoryProfile } from '../ui/memory-profile';
import { AudioOutput } from './audio-output';
import { PlayerController } from './player-controller';

export function createController(): PlayerController {
  const params = new URLSearchParams(location.search);
  // Test-only (E2E): ?bdjfail=1, ?nonestedworkers=1, ?nodecoder=1 and ?telemetry=1 go to the engine worker as flags in
  // its name (engine/worker.ts): an unreadable class library, no workers started from workers, no video decoder
  // configuration supported, the BD-J plane's hash in telemetry.
  const flags = ['bdjfail', 'nonestedworkers', 'nodecoder', 'telemetry'].filter((f) => params.has(f));
  // (the options stay an object literal with a literal type: Vite reads it to bundle the worker as a module)
  const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module', name: flags.length > 0 ? `bluray-engine:${flags.join(',')}` : 'bluray-engine' });
  const controller = new PlayerController(worker, new AudioOutput());
  controller.setMemoryProfile(chooseMemoryProfile({
    search: location.search,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
    platform: navigator.platform,
  }));
  // what a BD-J disc saved in its last seconds is stored before the page goes (iOS often skips pagehide: hidden too)
  addEventListener('pagehide', () => controller.flushSaves());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') controller.flushSaves();
  });
  if (params.has('telemetry')) {
    const target = window as unknown as { __blurayTelemetry?: Telemetry | null };
    controller.subscribe(() => {
      target.__blurayTelemetry = controller.getSnapshot().telemetry;
    });
  }
  return controller;
}
