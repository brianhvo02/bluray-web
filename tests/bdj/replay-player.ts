import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRing, renderQuantum, ringViews } from '../../src/engine/audio/ring';
import { runBdjWorker, type BdjPort, type BdjWorkerHandle } from '../../src/engine/bdj/bdj-worker';
import type { TraceEntry } from '../../src/engine/bdj/host';
import type { ClassLibrarySource } from '../../src/engine/bdj/runtime';
import type { WorkerLike } from '../../src/engine/bdj/session';
import type { BdjCallName, BdjWireValue, FromBdj, ToBdj } from '../../src/engine/bdj/worker-protocol';
import { createAudioDecoderFactory } from '../../src/engine/decode/audio-decoder';
import { Player } from '../../src/engine/player';
import type { EngineEvent } from '../../src/engine/protocol';
import { fakeVideoCodecApi } from '../helpers/fake-video-decoder';
import { directoryEntries } from '../helpers/file-blob';
import { HARNESS_SETTINGS } from './replay';

const jar = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../src/bdj-classlib/${name}`, import.meta.url))));

/** One virtual-clock step: 5 render quanta of 128 frames at 48 kHz. */
const STEP_MS = 640 / 48;

export interface PlayerBdjReplay {
  /** Java's calls that the engine answered, in reply order, in trace.patch's format. */
  readonly trace: TraceEntry[];
  /** Wall time from the open command to Java's first selectPlaylist reaching the engine. */
  readonly firstPlaylistMs: number;
  /** Wall time from the open command to the reply that ended the run. */
  readonly untilMs: number;
  /** Virtual (player clock) time from the open command to the end of the run. */
  readonly virtualMs: number;
  /** Everything the player emitted up to the end of the run (not the close that follows). */
  readonly events: readonly EngineEvent[];
}

/** sixDigits: %.6g of a Java float, as trace.patch prints selectRateN's rate. */
const sixDigits = (v: number): number => Number(v.toPrecision(6));

/** A call and the engine's reply as tools/bdj-trace/trace.patch prints the native: `<name>N`, Java ints signed. */
export function traceEntryOf(name: BdjCallName, args: readonly BdjWireValue[], value: number | string): TraceEntry {
  const call = `${name}N`;
  switch (name) {
    case 'selectRate':
      return { call, args: [sixDigits(Number(args[0])), args[1]!], ret: Number(value) | 0 };
    case 'writeReg':
      return { call, args: args.map((a) => Number(a) | 0), ret: Number(value) | 0 };
    case 'seek':
      return { call, args: [...args], ret: String(value) };
    case 'setUOMask':
    case 'setKeyInterest':
      return { call, args: [...args], ret: null };
    default:
      return { call, args: [...args], ret: Number(value) | 0 };
  }
}

/**
 * Two ends of an in-process channel between the engine and runBdjWorker: messages are delivered by reference (the
 * disc's Blob stand-ins for clips over 4 GiB cannot be cloned) on a later macrotask, in order, as a MessagePort does.
 */
function inProcessWorker(onToBdj: (m: ToBdj) => void, onFromBdj: (m: FromBdj) => void): WorkerLike {
  let closed = false;
  let handle: BdjWorkerHandle | null = null;
  const port: BdjPort = {
    onmessage: null,
    postMessage: (m) =>
      setImmediate(() => {
        if (closed) return;
        onFromBdj(m);
        worker.onmessage?.({ data: m } as MessageEvent<FromBdj>);
      }),
  };
  const worker: WorkerLike = {
    onmessage: null,
    postMessage: (m) => {
      onToBdj(m);
      setImmediate(() => {
        if (!closed) port.onmessage?.({ data: m });
      });
    },
    terminate: () => {
      closed = true;
      handle?.runtime?.jvm.threads.halt();
    },
  };
  handle = runBdjWorker(port);
  return worker;
}

/**
 * Opens a disc directory in the real Player (fake video decoders, no compressed audio decoders, LPCM played through
 * a render loop), with BD-J in an in-process runBdjWorker and the bdj-trace harness's player settings. The player's
 * clock is virtual and runs ahead in steps as fast as the engine keeps up, so playlists end through the player's own
 * end-of-playlist path in a fraction of their duration. Records Java's calls as the engine replies to them and stops
 * after the `occurrence`-th reply to `until` (a trace name such as selectPlaylistN). A thrown Error carries the trace
 * recorded so far as `trace`.
 */
export async function replayPlayerBdj(
  discDir: URL | string,
  opts: { until: string; occurrence?: number; timeoutMs?: number; log?: (line: string) => void; classLibrary?: ClassLibrarySource },
): Promise<PlayerBdjReplay> {
  const dir = typeof discDir === 'string' ? discDir : fileURLToPath(discDir);
  const occurrence = opts.occurrence ?? 1;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const classes: ClassLibrarySource = opts.classLibrary ?? {
    rt: jar('rt-bdj.jar'),
    libbluray: jar('libbluray-j2se.jar'),
    libblurayAwt: jar('libbluray-awt-j2se.jar'),
  };
  const trace: TraceEntry[] = [];
  const calls = new Map<number, { name: BdjCallName; args: readonly BdjWireValue[] }>();
  const events: EngineEvent[] = [];
  const clock = { ms: 1000 };
  let seen = 0;
  let done = false;
  let firstPlaylistAt: number | null = null;
  let t0 = 0;

  const onFromBdj = (m: FromBdj): void => {
    if (m.type !== 'call') return;
    calls.set(m.id, { name: m.name, args: m.args });
    if (m.name === 'selectPlaylist' && firstPlaylistAt === null) firstPlaylistAt = performance.now();
  };
  const onToBdj = (m: ToBdj): void => {
    if (m.type !== 'reply' || done) return;
    const c = calls.get(m.id);
    if (!c) return;
    calls.delete(m.id);
    const e = traceEntryOf(c.name, c.args, m.value);
    trace.push(e);
    if (e.call === opts.until && ++seen >= occurrence) done = true;
  };

  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeVideoCodecApi,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm in the replay'))),
    createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }),
    // the replay has its own timeout; the first-playlist timer would measure the virtual clock's real-time steps
    setTimer: () => () => undefined,
    createBdjWorker: () => inProcessWorker(onToBdj, onFromBdj),
    loadClassLibrary: async () => classes,
    bdjLog: opts.log ? (line) => opts.log!(line) : undefined,
    playerSettings: HARNESS_SETTINGS,
  });
  const fail = (why: string): Error =>
    Object.assign(new Error(`replayPlayerBdj: ${why} before ${opts.until}#${occurrence} (${trace.length} calls traced)`), { trace: [...trace] });
  try {
    const ring = createRing(48_000, 2);
    const views = ringViews(ring);
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    await player.handle({ type: 'attachAudio', ring });
    await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
    const start = clock.ms;
    t0 = performance.now();
    await player.handle({ type: 'open', entries: await directoryEntries(dir) });
    while (!done) {
      if (performance.now() - t0 > timeoutMs) throw fail(`timed out after ${timeoutMs} ms`);
      const failed = events.find((e) => e.type === 'notice' && e.code === 'bdj-failed');
      if (failed?.type === 'notice') throw fail(`BD-J failed (${failed.message})`);
      if (events.some((e) => e.type === 'state' && e.state === 'error')) throw fail('the player failed');
      clock.ms += STEP_MS;
      for (let q = 0; q < 5; q++) renderQuantum(views, left, right);
      player.tick();
      await new Promise((r) => setTimeout(r, 1));
    }
    const end = performance.now();
    return {
      trace,
      firstPlaylistMs: (firstPlaylistAt ?? end) - t0,
      untilMs: end - t0,
      virtualMs: clock.ms - start,
      events: [...events], // before the close in finally
    };
  } finally {
    await player.handle({ type: 'close' });
  }
}
