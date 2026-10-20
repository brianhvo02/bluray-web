import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
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
   * The run's bytes of a file, [startByte, endByte): from the first interval's EP entry to the run's end. A pipe's bytes
   * are already that range. (ffmpeg's `-ss` counts from its own guess of the file's start time, which can be an audio
   * PTS before the video's, so a run is bounded by bytes instead, and `-copyts` keeps the clip's PTS.)
   */
  readonly startByte: number;
  readonly endByte: number;
  /** 90 kHz, the PTS of every EP entry of the run, in one STC sequence and increasing: each gets an IDR. */
  readonly keyframesPts90: readonly number[];
  /** The source's primary video PID; the output carries that stream only. */
  readonly videoPid: number;
  /** The source video's coding type (CLPI), which names the hardware decoder. */
  readonly sourceCoding: number;
  readonly level: LevelDef;
  /** Deinterlace the source to its frame rate (see `deinterlaces`). */
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
const PTS_WRAP = 2 ** 33;

/** `pts90` in seconds, floored to the microsecond: ffmpeg forces the first frame at or after it, so never past the frame. */
export function keyframeTime(pts90: number): string {
  const seconds = Math.floor(pts90 / 90_000);
  const micros = Math.floor(((pts90 % 90_000) * 1_000_000) / 90_000);
  return `${seconds}.${String(micros).padStart(6, '0')}`;
}

function inputArgs(input: EncoderArgsInput): string[] {
  if (input.file === 'pipe:0') return ['-i', 'pipe:0'];
  return ['-nostdin', '-i', `subfile,,start,${input.startByte},end,${input.endByte},,:${input.file}`];
}

function mapArgs(input: EncoderArgsInput): string[] {
  return ['-map', `0:#0x${input.videoPid.toString(16)}`, '-an', '-sn', '-dn'];
}

function rateArgs(rateBps: number): string[] {
  const rate = Math.round(rateBps);
  return ['-b:v', String(rate), '-maxrate', String(Math.round(rate * PEAK_FACTOR)), '-bufsize', String(rate * BUFFER_FACTOR)];
}

/**
 * Every frame through as it comes (no frame-rate conversion: soft pulldown stays 23.976p), stamped on the 90 kHz clock:
 * the encoder's default time base is the frame rate's, which would move each PTS to its grid (1080i29.97 by 900 ticks)
 * and off the EP entries. `-mpegts_copyts` keeps the muxer from adding its 1.4 s delay.
 */
const OUTPUT = ['-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-mpegts_copyts', '1', '-f', 'mpegts', 'pipe:1'];
const HEAD = ['-hide_banner', '-nostats', '-loglevel', 'error'];

const QSV_DECODERS = new Map<number, string>([
  [CodingType.AVC, 'h264_qsv'],
  [CodingType.HEVC, 'hevc_qsv'],
  [CodingType.MPEG2_VIDEO, 'mpeg2_qsv'],
  [CodingType.VC1, 'vc1_qsv'],
]);

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
 * The NAS's Intel Quick Sync encoder (spec §2's spike): the source's QSV decoder, `scale_qsv` or `vpp_qsv` (advanced
 * deinterlacing, tone-mapping), `h264_qsv` at preset medium or `hevc_qsv` at veryfast, an IDR at every EP entry.
 */
export const qsvBackend: EncoderBackend = {
  binary: 'ffmpeg',
  args(input) {
    const { level } = input;
    const decoder = QSV_DECODERS.get(input.sourceCoding);
    if (!decoder) throw new Error(`levels: no QSV decoder for coding type 0x${input.sourceCoding.toString(16)}`);
    const hdr = input.hdr && level.hdr;
    const codec = level.codec === 'h264' ? ['-c:v', 'h264_qsv'] : ['-c:v', 'hevc_qsv', ...(hdr ? ['-profile:v', 'main10'] : [])];
    const preset = level.codec === 'h264' ? 'medium' : 'veryfast';
    const colour = hdr
      ? ['-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc']
      : input.hdr && level.tonemap
        ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
        : [];
    return [
      ...HEAD, '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-copyts', '-c:v', decoder,
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

/** Streams a clip's bytes [fromByte, toByte); without `toByte`, to its end. */
export type ClipReader = (fromByte: number, toByte?: number) => Readable;

/** The clip as a path ffmpeg opens itself, or a reader whose bytes are piped to it (an ISO image's extents). */
export type ClipInput = { readonly path: string } | { readonly read: ClipReader };

export interface ClipEncoderOptions {
  readonly input: ClipInput;
  readonly intervals: readonly IntervalPlan[];
  /** SPNs where the clip's STC sequences start (CLPI spnStcStart); a run never crosses one. */
  readonly stcStarts?: readonly number[];
  readonly videoPid: number;
  /** The source video's coding type (CLPI). */
  readonly sourceCoding: number;
  readonly level: LevelDef;
  /** Deinterlace to the frame rate: `deinterlaces(await probeScan(…))`. */
  readonly interlaced: boolean;
  readonly hdr: boolean;
  /** Default: the level's target. */
  readonly rateBps?: number;
  /** The most intervals one ffmpeg run covers (its keyframe list stays far below the argument limit). Default 300. */
  readonly maxIntervalsPerRun?: number;
  /** Injectable for tests. */
  readonly spawn?: typeof nodeSpawn;
}

export const MAX_INTERVALS_PER_RUN = 300;
const TS_PACKET = 188;
/** An EP entry's PTS keeps 45 kHz bits 8 and up (90 kHz bits 9 and up); frames are always more than 512 ticks apart. */
const EP_PTS_GRAIN = 512;
const STDERR_KEEP = 4096;

export interface ClipEncoderEvents {
  interval: [index: number, video: EncodedPes[]];
  error: [err: Error];
  /** The run finished at `lastIndex`, the last interval of its window; the caller starts the next run after it. */
  end: [lastIndex: number];
}

/**
 * A run's intervals: from `from`, in one STC sequence, with increasing PTS (no 33-bit wrap), at most `max`; and the
 * over-run interval after them when the run stops only for its size. With an open GOP, the source's leading pictures
 * of the next GOP (display time before the next EP entry, so the last interval's) come after that entry's bytes, so the
 * run reads the over-run interval too and forces its IDR: the encode's split stays aligned, and everything from that
 * IDR on is dropped.
 */
export function runWindow(
  intervals: readonly IntervalPlan[],
  from: number,
  stcStarts: readonly number[],
  max: number,
): { window: IntervalPlan[]; overrun: IntervalPlan | null; endSpn: number } {
  const first = intervals[from];
  if (!first) throw new Error(`levels: the clip has no interval ${from}`);
  const stcOf = (spn: number): number => stcStarts.filter((s) => s > 0 && s <= spn).length;
  // A new STC sequence, or a 33-bit PTS wrap, ends a run: ffmpeg would unwrap or jump the timestamps the splitter
  // matches on. (A wrap loses the leading pictures of the GOP after it: rare enough to accept.)
  const continues = (i: number): boolean =>
    stcOf(intervals[i]!.srcSpnStart) === stcOf(first.srcSpnStart) && intervals[i]!.startPts45 > intervals[i - 1]!.startPts45;
  const window = [first];
  let i = from + 1;
  for (; i < intervals.length && window.length < max && continues(i); i++) window.push(intervals[i]!);
  const overrun = i < intervals.length && continues(i) ? intervals[i]! : null;
  const last = overrun ?? window.at(-1)!;
  // The bytes end where the next STC sequence starts, else at the end of the over-run (or last) interval.
  const nextStc = stcStarts.find((s) => s > last.srcSpnStart && s < last.srcSpnEnd);
  return { window, overrun, endSpn: nextStc ?? last.srcSpnEnd };
}

/**
 * Runs ffmpeg over one window of a clip's EP intervals (`runWindow`: one STC sequence, at most 300 intervals) and hands
 * over the encoded video one interval at a time, in decode order: an access unit whose PTS is an EP entry's (to its
 * 512-tick grain) starts that entry's interval, and must be an IDR. Frames before the first interval's IDR (leading
 * pictures of an open GOP) are dropped, and so is everything from the over-run interval's IDR on. `end` follows the
 * window's last interval; a run that stops short is an error.
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
    const { window, overrun, endSpn } = runWindow(options.intervals, fromInterval, options.stcStarts ?? [], options.maxIntervalsPerRun ?? MAX_INTERVALS_PER_RUN);
    const first = window[0]!;
    const lastIndex = window.at(-1)!.index;
    const startByte = first.srcSpnStart * SOURCE_PACKET_BYTES;
    const endByte = endSpn * SOURCE_PACKET_BYTES;
    const piped = 'read' in options.input;
    const args = this.backend.args({
      file: 'path' in options.input ? options.input.path : 'pipe:0',
      startByte,
      endByte,
      keyframesPts90: [...window, ...(overrun ? [overrun] : [])].map((iv) => iv.startPts45 * 2),
      videoPid: options.videoPid,
      sourceCoding: options.sourceCoding,
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
      const reader = options.input.read(startByte, endByte);
      this.reader = reader;
      reader.on('error', (err) => fail(new Error(`levels: reading the clip failed: ${err.message}`)));
      // ffmpeg may stop reading before the range's end (stopped, or failed): a broken pipe is not an error of its own.
      child.stdin!.on('error', () => {});
      reader.pipe(child.stdin!);
    }

    const splitter = new IntervalSplitter(window, overrun, options.level.codec);
    let emitted = -1;
    const emit = (done: { index: number; video: EncodedPes[] }): void => {
      if (!live()) return;
      emitted = done.index;
      this.emit('interval', done.index, done.video);
    };
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
        for (let at = 0; at < whole && live(); at += TS_PACKET) for (const done of splitter.push(data, at)) emit(done);
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
        for (const done of splitter.finish()) emit(done);
      } catch (err) {
        fail(err as Error);
        return;
      }
      if (!live()) return;
      if (emitted !== lastIndex) {
        fail(new Error(`levels: ffmpeg ended after interval ${emitted} of a run to ${lastIndex}: ${stderr.trim()}`));
        return;
      }
      this.process = null;
      this.reader = null;
      this.emit('end', lastIndex);
    });
  }

  /** Stops reading ffmpeg's output (it then blocks on its pipe), so the caller can hold back: backpressure. */
  pause(): void {
    this.process?.stdout?.pause();
  }

  resume(): void {
    this.process?.stdout?.resume();
  }

  /** Stops the run and kills ffmpeg; no event follows. */
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

/** Collects ffmpeg's TS output (188-byte packets) into whole video PES, then into the run's intervals. */
class IntervalSplitter {
  private videoPid: number | null = null;
  private chunks: Uint8Array[] = [];
  private current: { plan: IntervalPlan; video: EncodedPes[] } | null = null;
  /** The over-run interval's IDR came: everything from it on is dropped. */
  private past = false;
  /** EP PTS grain → interval: unique within the run's one STC sequence. */
  private readonly starts: ReadonlyMap<number, IntervalPlan>;
  private readonly last: IntervalPlan;

  constructor(
    private readonly window: readonly IntervalPlan[],
    overrun: IntervalPlan | null,
    private readonly codec: LevelDef['codec'],
  ) {
    this.starts = new Map([...window, ...(overrun ? [overrun] : [])].map((iv) => [Math.floor((iv.startPts45 * 2) / EP_PTS_GRAIN), iv]));
    this.last = window.at(-1)!;
  }

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
    return [...(done ? [done] : []), ...(last && last.video.length > 0 ? [{ index: last.plan.index, video: last.video }] : [])];
  }

  private endPes(): { index: number; video: EncodedPes[] } | null {
    if (this.chunks.length === 0) return null;
    if (this.past) {
      this.chunks = [];
      return null;
    }
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
    // The PES carries the PTS modulo 2^33, as the EP map does; a run never crosses a wrap (`runWindow`).
    const pts = readTimestamp(pes, 9);
    const dts90 = pes[7]! >> 6 === 3 ? readTimestamp(pes, 14) : pts;
    const plan = this.starts.get(Math.floor(pts / EP_PTS_GRAIN));
    let done: { index: number; video: EncodedPes[] } | null = null;
    if (plan && plan !== this.current?.plan) {
      const expected = this.current ? this.current.plan.index + 1 : this.window[0]!.index;
      if (plan.index !== expected) throw new Error(`levels: the encode reached interval ${plan.index} where ${expected} was due`);
      const es = pes.subarray(9 + pes[8]!);
      const idr = this.codec === 'h264' ? analyzeAvc(es).idr : analyzeHevc(es).idr;
      if (!idr) throw new Error(`levels: interval ${plan.index} of the encode doesn't start with an IDR`);
      done = this.current ? { index: this.current.plan.index, video: this.current.video } : null;
      this.current = plan.index > this.last.index ? null : { plan, video: [] };
      this.past = this.current === null;
      if (this.past) return done;
    }
    // Before the first interval's IDR: leading pictures of the source's open GOP, not part of the run.
    if (!this.current) return done;
    const { plan: cur } = this.current;
    const offset = (pts - cur.startPts45 * 2 + PTS_WRAP) % PTS_WRAP;
    if (offset >= (cur.endPts45 - cur.startPts45) * 2) {
      // Past the window's end (the over-run's frames, should its IDR be late): not this run's.
      if (cur === this.last) return done;
      throw new Error(`levels: a frame of the encode lies past interval ${cur.index}`);
    }
    this.current.video.push({ pes, dts90 });
    return done;
  }
}

/** What the start of a clip's primary video says about its scan. */
export interface ScanInfo {
  /** Some frames are coded interlaced. */
  readonly interlaced: boolean;
  /** MPEG-2 repeat flags (soft pulldown): progressive film at 23.976 shown as 29.97i. */
  readonly softPulldown: boolean;
}

export const SCAN_PROBE_FRAMES = 120;

/**
 * Probes about the first 120 frames of the primary video from the clip's first EP entry (`startByte`) with ffprobe:
 * `interlaced_frame` and `repeat_pict` per frame. Task 6 calls it once per clip.
 */
export function probeScan(
  input: ClipInput,
  options: { readonly startByte: number; readonly videoPid: number; readonly binary?: string; readonly spawn?: typeof nodeSpawn },
): Promise<ScanInfo> {
  return new Promise((resolve, reject) => {
    const piped = 'read' in input;
    const source = piped ? 'pipe:0' : `subfile,,start,${options.startByte},end,0,,:${input.path}`;
    const args = [
      '-v', 'error', '-select_streams', `#0x${options.videoPid.toString(16)}`, '-read_intervals', `%+#${SCAN_PROBE_FRAMES}`,
      '-show_entries', 'frame=interlaced_frame,repeat_pict', '-of', 'json', '-i', source,
    ];
    const child = (options.spawn ?? nodeSpawn)(options.binary ?? 'ffprobe', args, { stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let reader: Readable | null = null;
    if ('read' in input) {
      reader = input.read(options.startByte);
      reader.on('error', (err) => {
        child.kill('SIGKILL');
        reject(new Error(`levels: reading the clip failed: ${err.message}`));
      });
      child.stdin!.on('error', () => {});
      reader.pipe(child.stdin!);
    }
    let out = '';
    let err = '';
    child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr!.on('data', (chunk: Buffer) => (err = (err + chunk.toString('utf8')).slice(-STDERR_KEEP)));
    child.on('error', (e) => reject(new Error(`levels: ffprobe did not start: ${e.message}`)));
    child.on('close', (code) => {
      reader?.destroy();
      if (code !== 0) return reject(new Error(`levels: ffprobe exited with ${code}: ${err.trim()}`));
      try {
        const frames = (JSON.parse(out) as { frames?: Array<{ interlaced_frame?: number; repeat_pict?: number }> }).frames ?? [];
        if (frames.length === 0) throw new Error('no frames');
        resolve({ interlaced: frames.some((f) => f.interlaced_frame === 1), softPulldown: frames.some((f) => (f.repeat_pict ?? 0) > 0) });
      } catch (e) {
        reject(new Error(`levels: ffprobe's frames could not be read: ${(e as Error).message}`));
      }
    });
  });
}

/** Whether to deinterlace: interlaced video is, soft-pulldown film is encoded as its progressive 23.976 frames. */
export function deinterlaces(scan: ScanInfo): boolean {
  return scan.interlaced && !scan.softPulldown;
}

export const MIN_RETRY_RATE_BPS = 1_000_000;
/** The retry aims this far under the rate that would just fill the budget. */
const RETRY_MARGIN = 0.95;

/** Encodes one interval of a clip at `rateBps` (a run of that interval alone) and returns its video. */
function encodeOne(backend: EncoderBackend, options: ClipEncoderOptions, index: number, rateBps: number): Promise<EncodedPes[]> {
  return new Promise((resolve, reject) => {
    const encoder = new ClipEncoder(backend, { ...options, rateBps, maxIntervalsPerRun: 1 });
    let video: EncodedPes[] | null = null;
    encoder.on('interval', (_, v) => (video = v));
    encoder.on('error', reject);
    encoder.on('end', () => (video ? resolve(video) : reject(new Error(`levels: the encode ended without interval ${index}`))));
    encoder.start(index);
  });
}

/**
 * The over-budget retry (Review Focus 1): re-encodes interval `index` at `rate × (budget ÷ actual) × 0.95`, where
 * `actual` is the re-muxed size the last try needed (budget + overflow), down to a floor of 1 Mbps, until `remux` fits
 * it into the plan's budget. One try is always made, at the floor at least. Throws when it doesn't fit at the floor: an
 * interval is never served truncated or oversized.
 */
export async function encodeIntervalAt(
  backend: EncoderBackend,
  options: ClipEncoderOptions,
  index: number,
  overflowed: { readonly rateBps: number; readonly overflowBytes: number },
  remux: (video: readonly EncodedPes[]) => { bytes: Uint8Array } | { overflow: number },
): Promise<{ bytes: Uint8Array; rateBps: number }> {
  const plan = options.intervals[index];
  if (!plan) throw new Error(`levels: the clip has no interval ${index}`);
  const budget = plan.budgetBytes;
  let rate = overflowed.rateBps;
  let overflow = overflowed.overflowBytes;
  do {
    rate = Math.max(MIN_RETRY_RATE_BPS, Math.round(((rate * budget) / (budget + overflow)) * RETRY_MARGIN));
    const result = remux(await encodeOne(backend, options, index, rate));
    if ('bytes' in result) return { bytes: result.bytes, rateBps: rate };
    overflow = result.overflow;
  } while (rate > MIN_RETRY_RATE_BPS);
  throw new Error(`levels: interval ${index} overflows its budget even at 1 Mbps`);
}
