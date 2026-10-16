import audioWasmUrl from '../wasm/audio/audio.wasm?url';
import defaultFontUrl from './ass/default-font.ttf?url';
import { readFontFile } from './ass/font-tables';
import { createFontFaceLoader } from './ass/fonts';
import { createCanvasMeasurer } from './ass/measure';
import { drawWarped } from './ass/warp';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import { loadAudioWasm } from './decode/wasm-audio';
import { browserVideoCodecApi } from './decode/video-decoder';
import { Player } from './player';
import type { EngineCommand, EngineEvent } from './protocol';
import { Compositor } from './render/compositor';
import { createWebGlBackend } from './shaders/webgl-backend';

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
  // WebGL2 on its own OffscreenCanvas, created when the first shader set is chosen
  createShaderBackend: (events) => createWebGlBackend((w, h) => new OffscreenCanvas(w, h), events),
  // Commands run one at a time, so a stalled download would block every later one: give up and report it instead.
  createAudioDecoder: createAudioDecoderFactory(() => loadAudioWasm(fetch(audioWasmUrl, { signal: AbortSignal.timeout(WASM_FETCH_TIMEOUT_MS) }))),
  // ASS: fonts in the worker's FontFaceSet, DejaVu Sans as the default font (libass's fallback in our harness)
  createAssDeps: async () => {
    const response = await fetch(defaultFontUrl, { signal: AbortSignal.timeout(WASM_FETCH_TIMEOUT_MS) });
    const defaultFont = await readFontFile('DejaVuSans.ttf', new Uint8Array(await response.arrayBuffer()));
    return {
      loader: createFontFaceLoader((self as unknown as { fonts: FontFaceSet }).fonts),
      defaultFont,
      measurer: createCanvasMeasurer(new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!),
      createCanvas: (w, h) => new OffscreenCanvas(w, h),
      Path2D,
      warp: drawWarped,
    };
  },
});

scope.onmessage = (event) => {
  void player.handle(event.data);
};
