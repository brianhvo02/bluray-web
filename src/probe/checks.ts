export interface ProbeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface WorkerProbe {
  /** null only when the folder has no HEVC clip; `error` is set when probing it failed. */
  readonly hevc: { hvc1: boolean; hev1: boolean; decoded: boolean; error?: string } | null;
  readonly raf: { present: boolean; p95Ms: number };
  readonly webgl: { float: boolean; half: boolean };
}

export interface ProbeEnv {
  pickFolder(): Promise<File[]>;
  createAudioContext(): BaseAudioContext;
  worker(entries: ReadonlyArray<readonly [string, File]>): Promise<WorkerProbe>;
  globals: Record<string, unknown>;
}

const FOUR_GIB = 2 ** 32;
const WORKER_TIMEOUT_MS = 15000;
const SOURCE_PACKET = 192;
const ALIGNED_UNIT = SOURCE_PACKET * 32;

async function blobSlice(files: readonly File[]): Promise<ProbeResult> {
  const name = 'blob-slice-over-4gib';
  const big = files.filter((f) => f.name.toLowerCase().endsWith('.m2ts')).sort((a, b) => b.size - a.size)[0];
  if (!big || big.size <= FOUR_GIB + SOURCE_PACKET) return { name, ok: false, detail: 'untested: no .m2ts over 4 GiB in the folder' };
  const offset = Math.floor((big.size - SOURCE_PACKET) / ALIGNED_UNIT) * ALIGNED_UNIT;
  const bytes = new Uint8Array(await big.slice(offset, offset + SOURCE_PACKET).arrayBuffer());
  const ok = bytes.length === SOURCE_PACKET && bytes[4] === 0x47;
  return { name, ok, detail: `offset ${offset} in ${big.name}: ${ok ? 'sync byte found' : `byte 4 is 0x${(bytes[4] ?? 0).toString(16)}`}` };
}

/** iOS folder picks may carry no folder paths; `normalizeDiscPaths` needs `BDMV/` in them to open a disc. */
function relativePath(files: readonly File[]): ProbeResult {
  const name = 'relative-path';
  const paths = files.map((f) => f.webkitRelativePath);
  const empty = paths.filter((p) => !p).length;
  const ok = paths.some((p) => p !== '' && (p.includes('/BDMV/') || p.startsWith('BDMV/')));
  return { name, ok, detail: `${paths[0] || '(empty)'} — ${empty}/${paths.length} empty` };
}

function proto(globals: Record<string, unknown>, key: string): object | undefined {
  const ctor = globals[key] as { prototype?: object } | undefined;
  return ctor?.prototype;
}

/** Draws a white square with and without `prop` set and reports whether the pixels differ. */
function canvasEffect(globals: Record<string, unknown>, prop: 'filter' | 'letterSpacing', value: string): ProbeResult {
  const name = prop === 'filter' ? 'canvas-filter' : 'letter-spacing';
  const p = proto(globals, 'OffscreenCanvasRenderingContext2D');
  if (!p || !(prop in p)) return { name, ok: false, detail: 'property missing' };
  const Canvas = globals.OffscreenCanvas as typeof OffscreenCanvas;
  const render = (apply: boolean): Uint8ClampedArray => {
    const ctx = new Canvas(64, 32).getContext('2d') as OffscreenCanvasRenderingContext2D;
    if (apply) (ctx as unknown as Record<string, string>)[prop] = value;
    ctx.fillStyle = '#fff';
    if (prop === 'filter') ctx.fillRect(24, 8, 16, 16);
    else {
      ctx.font = '16px sans-serif';
      ctx.fillText('iiiiii', 2, 20);
    }
    return ctx.getImageData(0, 0, 64, 32).data;
  };
  const a = render(false);
  const b = render(true);
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
  return { name, ok: changed > 0, detail: `${changed} channel values differ` };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function attempt(name: string, fn: () => Promise<ProbeResult> | ProbeResult): Promise<ProbeResult> {
  try {
    return await fn();
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error && err.message === 'timed out' ? 'timed out' : `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runChecks(env: ProbeEnv): Promise<ProbeResult[]> {
  const files = await env.pickFolder();
  const g = env.globals;
  const nav = g.navigator as object | undefined;
  const entries = files.map((f) => [f.webkitRelativePath || f.name, f] as const);
  const workerProbe = withTimeout(env.worker(entries), WORKER_TIMEOUT_MS);
  workerProbe.catch(() => undefined); // each worker-backed check reports the failure itself

  return [
    await attempt('blob-slice-over-4gib', () => blobSlice(files)),
    await attempt('audio-sample-rate', () => {
      const context = env.createAudioContext();
      const rate = context.sampleRate;
      void (context as { close?: () => Promise<void> }).close?.().catch(() => undefined);
      return { name: 'audio-sample-rate', ok: rate === 48000, detail: String(rate) };
    }),
    await attempt('audio-session', () => {
      const ok = !!nav && 'audioSession' in nav;
      return { name: 'audio-session', ok, detail: ok ? 'present' : 'missing' };
    }),
    await attempt('worker-raf', async () => {
      const { raf } = await workerProbe;
      return { name: 'worker-raf', ok: raf.present, detail: `${raf.present ? 'rAF' : 'setTimeout'} p95 ${raf.p95Ms.toFixed(1)} ms` };
    }),
    await attempt('hevc', async () => {
      const { hevc } = await workerProbe;
      if (!hevc) return { name: 'hevc', ok: false, detail: 'no HEVC clip in the folder' };
      if (hevc.error) return { name: 'hevc', ok: false, detail: `error: ${hevc.error}` };
      const form = hevc.hvc1 ? 'hvc1' : hevc.hev1 ? 'hev1' : 'unsupported';
      return { name: 'hevc', ok: (hevc.hvc1 || hevc.hev1) && hevc.decoded, detail: hevc.decoded ? form : `${form}, first GOP did not decode` };
    }),
    await attempt('webgl2-float', async () => {
      const { webgl } = await workerProbe;
      return { name: 'webgl2-float', ok: webgl.float, detail: `float ${webgl.float}, half-float ${webgl.half}` };
    }),
    await attempt('canvas-filter', () => canvasEffect(g, 'filter', 'blur(4px)')),
    await attempt('letter-spacing', () => canvasEffect(g, 'letterSpacing', '8px')),
    await attempt('fullscreen', () => {
      const ok = (g.document as { fullscreenEnabled?: boolean } | undefined)?.fullscreenEnabled === true;
      return { name: 'fullscreen', ok, detail: String(ok) };
    }),
    await attempt('webkitdirectory', () => {
      const p = proto(g, 'HTMLInputElement');
      const ok = !!p && 'webkitdirectory' in p;
      return { name: 'webkitdirectory', ok, detail: String(ok) };
    }),
    await attempt('relative-path', () => relativePath(files)),
  ];
}
