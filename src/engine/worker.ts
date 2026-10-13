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

const player = new Player({
  emit: (event) => scope.postMessage(event),
  videoCodecApi: browserVideoCodecApi,
  nowMs: () => performance.now(),
  requestFrame: (callback) => {
    if (scope.requestAnimationFrame) scope.requestAnimationFrame(() => callback());
    else setTimeout(callback, 16);
  },
  createCompositor: (canvas) => new Compositor(canvas),
  createAudioDecoder: createAudioDecoderFactory(() => loadAudioWasm(fetch(audioWasmUrl))),
});

scope.onmessage = (event) => {
  void player.handle(event.data);
};
