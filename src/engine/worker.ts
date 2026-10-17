import audioWasmUrl from '../wasm/audio/audio.wasm?url';
import rtJarUrl from '../bdj-classlib/rt-bdj.jar?url';
import libblurayJarUrl from '../bdj-classlib/libbluray-j2se.jar?url';
import libblurayAwtJarUrl from '../bdj-classlib/libbluray-awt-j2se.jar?url';
import defaultFontUrl from './ass/default-font.ttf?url';
import { readFontFile } from './ass/font-tables';
import { createFontFaceLoader } from './ass/fonts';
import { createCanvasMeasurer } from './ass/measure';
import { drawWarped } from './ass/warp';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import { loadAudioWasm } from './decode/wasm-audio';
import { browserVideoCodecApi } from './decode/video-decoder';
import { playerSettingsForLocale } from './disc/player-settings';
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
/**
 * Test-only (E2E): the page names the worker this when opened with ?bdjfail=1 (create-controller.ts, like ?telemetry=1).
 * The libbluray jar is then unreadable, so every BD-J boot fails and the fallback (spec §5) can be seen in the browser.
 */
const BDJ_FAIL_WORKER_NAME = 'bluray-engine:bdjfail'; // the same name in src/player/create-controller.ts
const brokenClassLibrary = (self as unknown as { name?: string }).name === BDJ_FAIL_WORKER_NAME;
const ASSET_FETCH_TIMEOUT_MS = 20_000; // the audio wasm, the default font and the class library jars

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

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
  createAudioDecoder: createAudioDecoderFactory(() => loadAudioWasm(fetch(audioWasmUrl, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) }))),
  createBdjWorker: () => new Worker(new URL('./bdj/bdj-worker-entry.ts', import.meta.url), { type: 'module' }),
  loadClassLibrary: async () => {
    const [rt, libbluray, libblurayAwt] = await Promise.all([fetchBytes(rtJarUrl), fetchBytes(libblurayJarUrl), fetchBytes(libblurayAwtJarUrl)]);
    return { rt, libbluray: brokenClassLibrary ? new Uint8Array(0) : libbluray, libblurayAwt };
  },
  // bd_set_player_setting_str as a player application sets it: the browser's language and region
  playerSettings: playerSettingsForLocale(navigator.language),
  bdjLog: (line, error) => (error ? console.warn : console.debug)(`[BD-J] ${line}`),
  // ASS: fonts in the worker's FontFaceSet, DejaVu Sans as the default font (libass's fallback in our harness)
  createAssDeps: async () => {
    const response = await fetch(defaultFontUrl, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) });
    const defaultFont = await readFontFile('DejaVuSans.ttf', new Uint8Array(await response.arrayBuffer()));
    return {
      loader: createFontFaceLoader((self as unknown as { fonts: FontFaceSet }).fonts),
      defaultFont,
      measurer: createCanvasMeasurer(new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!),
      createCanvas: (w, h) => new OffscreenCanvas(w, h),
      Path2D,
      canvasFilter: supportsCanvasFilter(),
      warp: drawWarped,
    };
  },
});

scope.onmessage = (event) => {
  void player.handle(event.data);
};

/** Whether a 2D canvas applies `ctx.filter` (Safari ignores it): a blurred dot must spread to its neighbour. */
function supportsCanvasFilter(): boolean {
  try {
    const canvas = new OffscreenCanvas(9, 9);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.filter = 'blur(2px)';
    ctx.fillStyle = '#fff';
    ctx.fillRect(4, 4, 1, 1);
    return ctx.getImageData(5, 4, 1, 1).data[3]! > 0;
  } catch {
    return false;
  }
}
