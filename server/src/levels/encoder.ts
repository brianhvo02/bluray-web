import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { analyzeAvc } from '../../../src/engine/decode/h264';
import { analyzeHevc } from '../../../src/engine/decode/hevc';
import { readTimestamp } from '../../../src/engine/demux/pes-assembler';
import { parseSourcePacket } from '../../../src/engine/demux/ts-packet';
import { SOURCE_PACKET_BYTES, type IntervalPlan, type LevelDef } from './levels';
import type { EncodedPes } from './remux';

/** What an encoder backend needs to build one ffmpeg run. */
export interface EncoderArgsInput {
  /** The clip's path, read by ffmpeg itself, or `pipe:0` when its bytes come on stdin (an ISO image's extents). */
  readonly file: string;
  /**
   * Where ffmpeg starts reading a file: the first interval's first source packet × 192. A pipe's bytes already start
   * there. (ffmpeg's `-ss` counts from its own guess of the file's start time, which can be an audio PTS before the
   * video's, so the run starts at the EP entry's bytes instead, and `-copyts` keeps the clip's PTS.)
   */
  readonly startByte: number;
  /** 90 kHz, every EP entry's PTS from the first interval on: each gets an IDR. */
  readonly keyframesPts90: readonly number[];
  /** The source's primary video PID; the output carries that stream only. */
  readonly videoPid: number;
  readonly level: LevelDef;
  /** The source is interlaced: it is deinterlaced to its frame rate. */
  readonly interlaced: boolean;
  /** The source is HDR10: an `hdr` level keeps it (Main10), a `tonemap` level maps it to SDR. */
  readonly hdr: boolean;
  /** The encoder's target rate, bits per second; maxrate is 1.25 × it, the buffer 2 × it. */
  readonly rateBps: number;
}

export interface EncoderBackend {
  readonly binary: string;
  args(input: EncoderArgsInput): string[];
}

/** A long GOP: the forced keyframes at EP entries are the ones that matter. */
const GOP_FRAMES = 1000;
const PEAK_FACTOR = 1.25;
const BUFFER_FACTOR = 2;

/** `pts90` in seconds, floored to the microsecond: ffmpeg forces the first frame at or after it, so never past the frame. */
export function keyframeTime(pts90: number): string {
  const seconds = Math.floor(pts90 / 90_000);
  const micros = Math.floor(((pts90 % 90_000) * 1_000_000) / 90_000);
  return `${seconds}.${String(micros).padStart(6, '0')}`;
}

function inputArgs(input: EncoderArgsInput): string[] {
  if (input.file === 'pipe:0') return ['-i', 'pipe:0'];
  return ['-nostdin', '-skip_initial_bytes', String(input.startByte), '-i', input.file];
}

function mapArgs(input: EncoderArgsInput): string[] {
  return ['-map', `0:#0x${input.videoPid.toString(16)}`, '-an', '-sn', '-dn'];
}

function rateArgs(rateBps: number): string[] {
  const rate = Math.round(rateBps);
  return ['-b:v', String(rate), '-maxrate', String(Math.round(rate * PEAK_FACTOR)), '-bufsize', String(rate * BUFFER_FACTOR)];
}

/**
 * Every frame through as it comes (no frame-rate conversion), stamped on the 90 kHz clock: the encoder's default time
 * base is the frame rate's, which would move each PTS to its grid (1080i29.97 by 900 ticks) and off the EP entries.
 */
const OUTPUT = ['-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-mpegts_copyts', '1', '-f', 'mpegts', 'pipe:1'];
const HEAD = ['-hide_banner', '-nostats', '-loglevel', 'error'];

/** The QSV video filter: scale (and P010 for HDR), deinterlace, or tone-map, as the level and source need. */
function qsvFilter(input: EncoderArgsInput): string {
  const { level } = input;
  const size = `w=${level.width}:h=${level.height}`;
  const tonemap = input.hdr && level.tonemap;
  const p010 = input.hdr && level.hdr;
  const deinterlace = input.interlaced ? 'deinterlace=2:' : '';
  if (tonemap) return `vpp_qsv=${deinterlace}${size}:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709`;
  const format = p010 ? ':format=p010' : '';
  if (input.interlaced) return `vpp_qsv=${deinterlace}${size}${format}`;
  return `scale_qsv=${size}${format}`;
}

/**
 * The NAS's Intel Quick Sync encoder (spec §2's spike): hardware decode, `scale_qsv` or `vpp_qsv` (advanced
 * deinterlacing, tone-mapping), `h264_qsv` at preset medium or `hevc_qsv` at veryfast, an IDR at every EP entry.
 */
export const qsvBackend: EncoderBackend = {
  binary: 'ffmpeg',
  args(input) {
    const { level } = input;
    const hdr = input.hdr && level.hdr;
    const codec = level.codec === 'h264' ? ['-c:v', 'h264_qsv'] : ['-c:v', 'hevc_qsv', ...(hdr ? ['-profile:v', 'main10'] : [])];
    const preset = level.codec === 'h264' ? 'medium' : 'veryfast';
    const colour = hdr ? ['-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc'] : [];
    return [
      ...HEAD, '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-copyts',
      ...inputArgs(input), ...mapArgs(input),
      '-vf', qsvFilter(input),
      ...codec, '-preset', preset, ...rateArgs(input.rateBps), ...colour,
      '-forced_idr', '1', '-force_key_frames', input.keyframesPts90.map(keyframeTime).join(','), '-g', String(GOP_FRAMES),
      ...OUTPUT,
    ];
  },
};

/** Software H.264 (libx264), for machines without Quick Sync, such as CI. HDR sources and HEVC levels aren't supported. */
export const x264Backend: EncoderBackend = {
  binary: 'ffmpeg',
  args(input) {
    const { level } = input;
    if (level.codec !== 'h264') throw new Error(`levels: x264Backend encodes H.264 levels only, not ${level.id}`);
    const filters = [...(input.interlaced ? ['bwdif=mode=send_frame'] : []), `scale=${level.width}:${level.height}`];
    return [
      ...HEAD, '-copyts',
      ...inputArgs(input), ...mapArgs(input),
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', ...rateArgs(input.rateBps),
      '-x264-params', `keyint=${GOP_FRAMES}`, '-forced-idr', '1', '-force_key_frames', input.keyframesPts90.map(keyframeTime).join(','),
      ...OUTPUT,
    ];
  },
};

/** Streams a clip's bytes from an offset to its end. */
export type ClipReader = (fromByte: number) => Readable;

export interface ClipEncoderOptions {
  /** The clip as a path ffmpeg opens itself, or a reader whose bytes are piped to ffmpeg (an ISO image's extents). */
  readonly input: { readonly path: string } | { readonly read: ClipReader };
  readonly intervals: readonly IntervalPlan[];
  readonly videoPid: number;
  readonly level: LevelDef;
  readonly interlaced: boolean;
  readonly hdr: boolean;
  /** Default: the level's target. */
  readonly rateBps?: number;
  /** Injectable for tests. */
  readonly spawn?: typeof nodeSpawn;
}

const TS_PACKET = 188;
/** An EP entry's PTS keeps 45 kHz bits 8 and up (90 kHz bits 9 and up); frames are always more than 512 ticks apart. */
const EP_PTS_GRAIN = 512;
const STDERR_KEEP = 4096;

export interface ClipEncoderEvents {
  interval: [index: number, video: EncodedPes[]];
  error: [err: Error];
  /** ffmpeg finished the clip; every interval from the start one on was emitted. */
  end: [];
}

/**
 * Runs one ffmpeg process over a clip from an EP interval on and hands over the encoded video one interval at a time,
 * in decode order: an access unit whose PTS is an EP entry's (to its 512-tick grain) starts that entry's interval, and
 * must be an IDR. Frames before the first interval's IDR (leading pictures of an open GOP) are dropped. The interval
 * still open when ffmpeg ends at the clip's end is the last one.
 */
export class ClipEncoder extends EventEmitter<ClipEncoderEvents> {
  private process: ChildProcess | null = null;
  private reader: Readable | null = null;
  /** Bumped on every start and stop, so a dead run's callbacks do nothing. */
  private run = 0;

  constructor(
    private readonly backend: EncoderBackend,
    private readonly options: ClipEncoderOptions,
  ) {
    super();
  }

  start(fromInterval: number): void {
    this.stop();
    const run = ++this.run;
    const { options } = this;
    const intervals = options.intervals.slice(fromInterval);
    const first = intervals[0];
    if (!first) throw new Error(`levels: the clip has no interval ${fromInterval}`);
    const keyframes = intervals.map((iv) => iv.startPts45 * 2);
    const piped = 'read' in options.input;
    const args = this.backend.args({
      file: 'path' in options.input ? options.input.path : 'pipe:0',
      startByte: first.srcSpnStart * SOURCE_PACKET_BYTES,
      keyframesPts90: keyframes,
      videoPid: options.videoPid,
      level: options.level,
      interlaced: options.interlaced,
      hdr: options.hdr,
      rateBps: options.rateBps ?? options.level.targetBps,
    });
    const child = (options.spawn ?? nodeSpawn)(this.backend.binary, args, { stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    this.process = child;
    const live = (): boolean => run === this.run;
    const fail = (err: Error): void => {
      if (!live()) return;
      this.stop();
      this.emit('error', err);
    };

    if ('read' in options.input) {
      const reader = options.input.read(first.srcSpnStart * SOURCE_PACKET_BYTES);
      this.reader = reader;
      reader.on('error', (err) => fail(new Error(`levels: reading the clip failed: ${err.message}`)));
      // ffmpeg may stop reading before the clip's end (stopped, or failed): a broken pipe is not an error of its own.
      child.stdin!.on('error', () => {});
      reader.pipe(child.stdin!);
    }

    const splitter = new IntervalSplitter(
      new Map(intervals.map((iv) => [Math.floor((iv.startPts45 * 2) / EP_PTS_GRAIN), iv.index])),
      first.index,
      options.level.codec,
    );
    let stderr = '';
    let pending = new Uint8Array(0);
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP);
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (!live()) return;
      const data = pending.length ? concat(pending, chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const whole = data.length - (data.length % TS_PACKET);
      try {
        for (let at = 0; at < whole && live(); at += TS_PACKET) {
          for (const done of splitter.push(data, at)) if (live()) this.emit('interval', done.index, done.video);
        }
      } catch (err) {
        fail(err as Error);
        return;
      }
      pending = data.slice(whole);
    });
    child.on('error', (err) => fail(new Error(`levels: ffmpeg did not start: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (!live()) return;
      if (code !== 0) {
        fail(new Error(`levels: ffmpeg exited with ${code ?? signal}: ${stderr.trim()}`));
        return;
      }
      try {
        const last = splitter.finish();
        this.process = null;
        this.reader = null;
        for (const done of last) if (live()) this.emit('interval', done.index, done.video);
        if (live()) this.emit('end');
      } catch (err) {
        fail(err as Error);
      }
    });
  }

  /** Stops the run; no event follows. */
  stop(): void {
    this.run++;
    this.reader?.destroy();
    this.reader = null;
    this.process?.kill('SIGKILL');
    this.process = null;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Collects ffmpeg's TS output (188-byte packets) into whole video PES, then into intervals. */
class IntervalSplitter {
  private videoPid: number | null = null;
  private chunks: Uint8Array[] = [];
  private current: { index: number; video: EncodedPes[] } | null = null;

  constructor(
    /** EP PTS grain → interval index, from the first interval on. */
    private readonly starts: ReadonlyMap<number, number>,
    private readonly firstIndex: number,
    private readonly codec: LevelDef['codec'],
  ) {}

  /** Parses the packet at `at` of `data`; returns the intervals it completed. */
  push(data: Uint8Array, at: number): Array<{ index: number; video: EncodedPes[] }> {
    if (data[at] !== 0x47) throw new Error('levels: ffmpeg wrote a TS packet without its sync byte');
    // parseSourcePacket reads a 192-byte source packet; a 188-byte TS packet is one without its 4-byte header.
    const ts = parseSourcePacket(data, at - 4);
    if (!ts || !ts.hasPayload) return [];
    const p = ts.payload;
    const startsPes = ts.payloadUnitStart && p.length >= 4 && p[0] === 0 && p[1] === 0 && p[2] === 1 && (p[3]! & 0xf0) === 0xe0;
    if (this.videoPid === null) {
      if (!startsPes) return [];
      this.videoPid = ts.pid;
    }
    if (ts.pid !== this.videoPid) return [];
    const out: Array<{ index: number; video: EncodedPes[] }> = [];
    if (ts.payloadUnitStart) {
      const done = this.endPes();
      if (done) out.push(done);
    }
    this.chunks.push(p.slice());
    return out;
  }

  /** The end of ffmpeg's output: the intervals its last PES completed, then the one still open. */
  finish(): Array<{ index: number; video: EncodedPes[] }> {
    const done = this.endPes();
    const last = this.current;
    this.current = null;
    return [...(done ? [done] : []), ...(last && last.video.length > 0 ? [last] : [])];
  }

  private endPes(): { index: number; video: EncodedPes[] } | null {
    if (this.chunks.length === 0) return null;
    const size = this.chunks.reduce((n, c) => n + c.length, 0);
    let pes = new Uint8Array(size);
    let at = 0;
    for (const c of this.chunks) {
      pes.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    if (pes.length < 14 || !(pes[7]! & 0x80)) throw new Error('levels: an encoded video PES has no PTS');
    const declared = (pes[4]! << 8) | pes[5]!;
    if (declared) pes = pes.subarray(0, 6 + declared);
    const pts = readTimestamp(pes, 9);
    const dts90 = pes[7]! >> 6 === 3 ? readTimestamp(pes, 14) : pts;
    const index = this.starts.get(Math.floor(pts / EP_PTS_GRAIN));
    let done: { index: number; video: EncodedPes[] } | null = null;
    if (index !== undefined && index !== this.current?.index) {
      const expected = this.current ? this.current.index + 1 : this.firstIndex;
      if (index !== expected) throw new Error(`levels: the encode reached interval ${index} where ${expected} was due`);
      const es = pes.subarray(9 + pes[8]!);
      const idr = this.codec === 'h264' ? analyzeAvc(es).idr : analyzeHevc(es).idr;
      if (!idr) throw new Error(`levels: interval ${index} of the encode doesn't start with an IDR`);
      done = this.current;
      this.current = { index, video: [] };
    }
    // Before the first interval's IDR: leading pictures of the source's open GOP, not part of the run.
    this.current?.video.push({ pes, dts90 });
    return done;
  }
}

const RETRY_FACTOR = 0.8;
export const MIN_RETRY_RATE_BPS = 1_000_000;

/** Encodes one interval of a clip at `rateBps` and returns its video. */
function encodeOne(backend: EncoderBackend, options: ClipEncoderOptions, index: number, rateBps: number): Promise<EncodedPes[]> {
  return new Promise((resolve, reject) => {
    const encoder = new ClipEncoder(backend, { ...options, rateBps });
    encoder.on('interval', (i, video) => {
      if (i !== index) return;
      encoder.stop();
      resolve(video);
    });
    encoder.on('error', reject);
    encoder.on('end', () => reject(new Error(`levels: the encode ended without interval ${index}`)));
    encoder.start(index);
  });
}

/**
 * The over-budget retry (Review Focus 1): re-encodes interval `index` at `rateBps × 0.8`, then × 0.8 again, down to
 * 1 Mbps, until `remux` fits it into its budget. Throws when it doesn't fit even at 1 Mbps: an interval is never served
 * truncated or oversized.
 */
export async function encodeIntervalAt(
  backend: EncoderBackend,
  options: ClipEncoderOptions,
  index: number,
  rateBps: number,
  remux: (video: readonly EncodedPes[]) => { bytes: Uint8Array } | { overflow: number },
): Promise<{ bytes: Uint8Array; rateBps: number }> {
  let rate = rateBps;
  for (let tries = 1; rate > MIN_RETRY_RATE_BPS; tries++) {
    rate = Math.max(MIN_RETRY_RATE_BPS, Math.round(rateBps * RETRY_FACTOR ** tries));
    const result = remux(await encodeOne(backend, options, index, rate));
    if ('bytes' in result) return { bytes: result.bytes, rateBps: rate };
  }
  throw new Error(`levels: interval ${index} overflows its budget even at 1 Mbps`);
}
