import audioWasmUrl from '../wasm/audio/audio.wasm?url';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import { loadAudioWasm } from './decode/wasm-audio';
import { browserVideoCodecApi } from './decode/video-decoder';
import { Player } from './player';
import type { EngineCommand, EngineEvent } from './protocol';
import { Compositor } from './render/compositor';

interface WorkerScope {
  postMessage(message: EngineEvent): void;
  onmessage: ((event: MessageEvent<EngineCommand>) => void) | null;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
}

const scope = self as unknown as WorkerScope;
const WASM_FETCH_TIMEOUT_MS = 20_000;

const player = new Player({
  emit: (event) => scope.postMessage(event),
  videoCodecApi: browserVideoCodecApi,
  nowMs: () => performance.now(),
  requestFrame: (callback) => {
    if (scope.requestAnimationFrame) scope.requestAnimationFrame(() => callback());
    else setTimeout(callback, 16);
  },
  createCompositor: (canvas) => new Compositor(canvas),
  // Commands run one at a time, so a stalled download would block every later one: give up and report it instead.
  createAudioDecoder: createAudioDecoderFactory(() => loadAudioWasm(fetch(audioWasmUrl, { signal: AbortSignal.timeout(WASM_FETCH_TIMEOUT_MS) }))),
});

scope.onmessage = (event) => {
  void player.handle(event.data);
};
