import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseClpi } from '../../../src/engine/bdmv/clpi-parser';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
import { analyzeAvc, avcIsInterlaced } from '../../../src/engine/decode/h264';
import { readTimestamp } from '../../../src/engine/demux/pes-assembler';
import { parseSourcePacket } from '../../../src/engine/demux/ts-packet';
import { KeptStreams, PesCoreFilter } from './audio-core';
import {
  ClipEncoder,
  MAX_INTERVALS_PER_RUN,
  deinterlaces,
  encodeIntervalAt,
  probeScan,
  qsvBackend,
  runWindow,
  x264Backend,
  type ClipEncoderOptions,
  type EncoderArgsInput,
  type EncoderBackend,
} from './encoder';
import { levelDefFor, planClip, type IntervalPlan, type LevelDef } from './levels';
import { IntervalCollector, remuxInterval, type EncodedPes, type IntervalSource } from './remux';

const VIDEO = 0x1011;
const fixture = (disc: string): string => join(import.meta.dirname, '../../../fixtures/synthetic', disc, 'BDMV');
const clipPath = (disc: string): string => join(fixture(disc), 'STREAM/00001.m2ts');
const intervalsOf = (disc: string): IntervalPlan[] =>
  planClip(parseClpi(readFileSync(join(fixture(disc), 'CLIPINF/00001.clpi'))), levelDefFor('h264-1080', { height: 1080 }), 192_000).intervals;

const hasX264 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264') ?? false;
/** CI installs ffmpeg: there, a missing libx264 fails these tests instead of skipping them. */
const runFfmpegTests = hasX264 || Boolean(process.env.CI);

const scratch = mkdtempSync(join(tmpdir(), 'encoder-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function argsInput(level: LevelDef, extra: Partial<EncoderArgsInput> = {}): EncoderArgsInput {
  return {
    file: '/discs/Starfall Wanderer/BDMV/STREAM/00001.m2ts',
    startByte: 1157 * 192,
    endByte: 2326 * 192,
    keyframesPts90: [989_696, 1_079_808, 1_169_920],
    videoPid: VIDEO,
    sourceCoding: CodingType.AVC,
    level,
    interlaced: false,
    hdr: false,
    rateBps: level.targetBps,
    ...extra,
  };
}

const KEYS = '10.996622,11.997866,12.999111';
const OUT = ['-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-mpegts_copyts', '1', '-f', 'mpegts', 'pipe:1'];
const TAIL = ['-forced_idr', '1', '-force_key_frames', KEYS, '-g', '1000', ...OUT];
const QSV_HEAD = ['-hide_banner', '-nostats', '-loglevel', 'error', '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-copyts', '-c:v', 'h264_qsv'];
const FILE_IN = ['-nostdin', '-i', 'subfile,,start,222144,end,446592,,:/discs/Starfall Wanderer/BDMV/STREAM/00001.m2ts'];
const MAP = ['-map', '0:#0x1011', '-an', '-sn', '-dn'];

describe('qsvBackend arguments', () => {
  it('h264-1080', () => {
    expect(qsvBackend.binary).toBe('ffmpeg');
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 })))).toEqual([
      ...QSV_HEAD, ...FILE_IN, ...MAP,
      '-vf', 'scale_qsv=w=1920:h=1080',
      '-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '8000000', '-maxrate', '10000000', '-bufsize', '16000000',
      ...TAIL,
    ]);
  });

  it('hevc-1080', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('hevc-1080', { height: 1080 })))).toEqual([
      ...QSV_HEAD, ...FILE_IN, ...MAP,
      '-vf', 'scale_qsv=w=1920:h=1080',
      '-c:v', 'hevc_qsv', '-preset', 'veryfast', '-b:v', '5000000', '-maxrate', '6250000', '-bufsize', '10000000',
      ...TAIL,
    ]);
  });

  it('phone-720, and the standard-definition size for a 576-line source', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('phone-720', { height: 1080 })))).toEqual([
      ...QSV_HEAD, ...FILE_IN, ...MAP,
      '-vf', 'scale_qsv=w=1280:h=720',
      '-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '3000000', '-maxrate', '3750000', '-bufsize', '6000000',
      ...TAIL,
    ]);
    expect(qsvBackend.args(argsInput(levelDefFor('phone-720', { height: 576 })))).toContain('scale_qsv=w=720:h=576');
  });

  it('hevc-1080-hdr: Main10, P010, HDR10 colour tags', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('hevc-1080-hdr', { height: 2160 }), { hdr: true, sourceCoding: CodingType.HEVC }))).toEqual([
      ...QSV_HEAD.slice(0, -1), 'hevc_qsv', ...FILE_IN, ...MAP,
      '-vf', 'scale_qsv=w=1920:h=1080:format=p010',
      '-c:v', 'hevc_qsv', '-profile:v', 'main10', '-preset', 'veryfast', '-b:v', '5000000', '-maxrate', '6250000', '-bufsize', '10000000',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
      ...TAIL,
    ]);
  });

  it('h264-1080-sdr: tone-mapped by vpp_qsv and tagged BT.709', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080-sdr', { height: 2160 }), { hdr: true, sourceCoding: CodingType.HEVC }))).toEqual([
      ...QSV_HEAD.slice(0, -1), 'hevc_qsv', ...FILE_IN, ...MAP,
      '-vf', 'vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709',
      '-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '8000000', '-maxrate', '10000000', '-bufsize', '16000000',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      ...TAIL,
    ]);
  });

  it('names the QSV decoder of the source before the input', () => {
    const level = levelDefFor('h264-1080', { height: 1080 });
    const decoderOf = (sourceCoding: number): string | undefined => {
      const args = qsvBackend.args(argsInput(level, { sourceCoding }));
      return args.indexOf('-c:v') < args.indexOf('-i') ? args[args.indexOf('-c:v') + 1] : undefined;
    };
    expect(decoderOf(CodingType.AVC)).toBe('h264_qsv');
    expect(decoderOf(CodingType.HEVC)).toBe('hevc_qsv');
    expect(decoderOf(CodingType.MPEG2_VIDEO)).toBe('mpeg2_qsv');
    expect(decoderOf(CodingType.VC1)).toBe('vc1_qsv');
    expect(() => qsvBackend.args(argsInput(level, { sourceCoding: CodingType.MPEG1_VIDEO }))).toThrow(/QSV decoder/);
  });

  it('deinterlaces an interlaced source with vpp_qsv (advanced, to the frame rate)', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { interlaced: true }))).toContain('vpp_qsv=deinterlace=2:w=1920:h=1080');
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080-sdr', { height: 2160 }), { interlaced: true, hdr: true }))).toContain(
      'vpp_qsv=deinterlace=2:w=1920:h=1080:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709',
    );
  });

  it('reads stdin for a piped clip, and uses the retry rate', () => {
    const args = qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { file: 'pipe:0', rateBps: 6_400_000 }));
    expect(args.slice(QSV_HEAD.length, QSV_HEAD.length + 2)).toEqual(['-i', 'pipe:0']);
    expect(args).not.toContain('-nostdin');
    expect(args.slice(args.indexOf('-b:v'), args.indexOf('-b:v') + 6)).toEqual(['-b:v', '6400000', '-maxrate', '8000000', '-bufsize', '12800000']);
  });

  it('floors keyframe times to the microsecond, never past the frame', () => {
    const args = qsvBackend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { keyframesPts90: [899_584, 90_000 * 3 + 1] }));
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('9.995377,3.000011');
  });
});

describe('x264Backend arguments', () => {
  it('libx264 with keyint, forced IDRs and the same rates', () => {
    expect(x264Backend.binary).toBe('ffmpeg');
    expect(x264Backend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { interlaced: true }))).toEqual([
      '-hide_banner', '-nostats', '-loglevel', 'error', '-copyts', ...FILE_IN, ...MAP,
      '-vf', 'bwdif=mode=send_frame,scale=1920:1080',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '8000000', '-maxrate', '10000000', '-bufsize', '16000000',
      '-x264-params', 'keyint=1000', '-forced-idr', '1', '-force_key_frames', KEYS, ...OUT,
    ]);
  });

  it('refuses HEVC levels', () => {
    expect(() => x264Backend.args(argsInput(levelDefFor('hevc-1080', { height: 1080 })))).toThrow(/H\.264/);
  });
});

/** A made-up clip plan: `count` intervals of one second, 1000 source packets each. */
function fakePlan(count: number, ptsAt: (i: number) => number = (i) => 450_000 + i * 45_000): IntervalPlan[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    startPts45: ptsAt(i),
    endPts45: ptsAt(i) + 45_000,
    srcSpnStart: i * 1000,
    srcSpnEnd: (i + 1) * 1000,
    budgetBytes: 6144,
    spnStart: i * 32,
  }));
}

describe('runWindow', () => {
  it('bounds a run of a long clip to 300 intervals (its keyframe list stays far below the argument limit)', () => {
    const plan = fakePlan(9000); // two and a half hours
    expect(MAX_INTERVALS_PER_RUN).toBe(300);
    const { window, endSpn } = runWindow(plan, 0, [], MAX_INTERVALS_PER_RUN);
    expect(window.map((iv) => iv.index)).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(endSpn).toBe(300_000);
    const args = x264Backend.args(argsInput(levelDefFor('h264-1080', { height: 1080 }), { keyframesPts90: window.map((iv) => iv.startPts45 * 2) }));
    expect(args.join(' ').length).toBeLessThan(8192);
    expect(runWindow(plan, 8900, [], MAX_INTERVALS_PER_RUN).window.length).toBe(100);
  });

  it('stops at the next STC sequence, its bytes ending where that sequence starts', () => {
    const plan = fakePlan(20, (i) => (i < 10 ? 450_000 + i * 45_000 : 90_000 + i * 45_000));
    const { window, endSpn } = runWindow(plan, 3, [0, 9_990], MAX_INTERVALS_PER_RUN);
    expect(window.map((iv) => iv.index)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(endSpn).toBe(9_990);
    expect(runWindow(plan, 10, [0, 9_990], MAX_INTERVALS_PER_RUN).window.map((iv) => iv.index)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('stops before a 33-bit PTS wrap', () => {
    const plan = fakePlan(6, (i) => (2 ** 32 - 3 * 45_000 + i * 45_000) % 2 ** 32);
    expect(runWindow(plan, 0, [], MAX_INTERVALS_PER_RUN).window.map((iv) => iv.index)).toEqual([0, 1, 2]);
    expect(runWindow(plan, 3, [], MAX_INTERVALS_PER_RUN).window.map((iv) => iv.index)).toEqual([3, 4, 5]);
  });
});

/** The payload of a whole video PES (after its optional header). */
const esOf = (pes: Uint8Array): Uint8Array => pes.subarray(9 + pes[8]!);
const ptsOf = (pes: Uint8Array): number => readTimestamp(pes, 9);

/** The PTS of the source's video PES. */
function sourceVideoPts(disc: string): number[] {
  const bytes = readFileSync(clipPath(disc));
  const out: number[] = [];
  for (let spn = 0; (spn + 1) * 192 <= bytes.length; spn++) {
    const ts = parseSourcePacket(bytes, spn * 192);
    if (!ts || ts.pid !== VIDEO || !ts.payloadUnitStart) continue;
    out.push(readTimestamp(ts.payload, 9));
  }
  return out;
}

interface Run {
  readonly intervals: Map<number, EncodedPes[]>;
  readonly lastIndex: number;
}

function encodeFrom(options: ClipEncoderOptions, from: number, backend: EncoderBackend = x264Backend): Promise<Run> {
  return new Promise((resolve, reject) => {
    const encoder = new ClipEncoder(backend, options);
    const intervals = new Map<number, EncodedPes[]>();
    encoder.on('interval', (index, video) => intervals.set(index, video));
    encoder.on('error', reject);
    encoder.on('end', (lastIndex) => resolve({ intervals, lastIndex }));
    encoder.start(from);
  });
}

/** Checks each interval against the source: an IDR at T_k, then exactly the source's frames of [T_k, T_k+1). */
function expectIntervals(disc: string, intervals: readonly IntervalPlan[], run: Run): void {
  const source = sourceVideoPts(disc).sort((a, b) => a - b);
  const frameAt = (pts45: number): number => source.find((p) => Math.floor(p / 512) * 256 === pts45)!;
  for (const [index, video] of run.intervals) {
    const plan = intervals[index]!;
    const start = frameAt(plan.startPts45);
    const next = intervals[index + 1];
    const end = next ? frameAt(next.startPts45) : plan.endPts45 * 2;
    expect(start).toBeDefined();
    const first = video[0]!.pes;
    expect(ptsOf(first)).toBe(start);
    expect(analyzeAvc(esOf(first)).idr).toBe(true);
    expect(video.slice(1).some((v) => analyzeAvc(esOf(v.pes)).idr)).toBe(false);
    expect(video.map((v) => ptsOf(v.pes)).sort((a, b) => a - b)).toEqual(source.filter((p) => p >= start && p < end));
    for (let i = 1; i < video.length; i++) expect(video[i]!.dts90).toBeGreaterThan(video[i - 1]!.dts90);
  }
}

/** A spawn that records the children it starts. */
function recordingSpawn(children: ChildProcess[], replace?: { binary: string; args: string[] }): typeof nodeSpawn {
  return ((binary: string, args: string[], options: object) => {
    const child = replace ? nodeSpawn(replace.binary, replace.args, options) : nodeSpawn(binary, args, options);
    children.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
}

describe.skipIf(!runFfmpegTests)('ClipEncoder (libx264)', () => {
  const level = levelDefFor('h264-1080', { height: 1080 });
  const base = { videoPid: VIDEO, sourceCoding: CodingType.AVC, level, interlaced: false, hdr: false };

  for (const input of ['path', 'reader'] as const) {
    it(`encodes disc-levels from interval 3: intervals 3…9, each opening with an IDR at its EP entry (${input})`, async () => {
      const intervals = intervalsOf('disc-levels');
      expect(intervals.length).toBe(10);
      const path = clipPath('disc-levels');
      const run = await encodeFrom(
        { ...base, input: input === 'path' ? { path } : { read: (from, to) => createReadStream(path, { start: from, end: to === undefined ? undefined : to - 1 }) }, intervals },
        3,
      );
      expect([...run.intervals.keys()]).toEqual([3, 4, 5, 6, 7, 8, 9]);
      expect(run.lastIndex).toBe(9);
      expectIntervals('disc-levels', intervals, run);
    }, 60_000);
  }

  it('ends a run at the end of its STC sequence; the next run starts in the next one', async () => {
    const intervals = intervalsOf('disc-levels');
    // A made-up second STC sequence from interval 5's EP entry on.
    const options = { ...base, input: { path: clipPath('disc-levels') }, intervals, stcStarts: [0, intervals[5]!.srcSpnStart] };
    const first = await encodeFrom(options, 3);
    expect([...first.intervals.keys()]).toEqual([3, 4]);
    expect(first.lastIndex).toBe(4);
    const second = await encodeFrom(options, first.lastIndex + 1);
    expect([...second.intervals.keys()]).toEqual([5, 6, 7, 8, 9]);
    expectIntervals('disc-levels', intervals, first);
    expectIntervals('disc-levels', intervals, second);
  }, 60_000);

  it('ends a run after its window of intervals', async () => {
    const intervals = intervalsOf('disc-levels');
    const run = await encodeFrom({ ...base, input: { path: clipPath('disc-levels') }, intervals, maxIntervalsPerRun: 3 }, 0);
    expect([...run.intervals.keys()]).toEqual([0, 1, 2]);
    expect(run.lastIndex).toBe(2);
    expectIntervals('disc-levels', intervals, run);
  }, 60_000);

  it('deinterlaces disc-mpeg2 (1080i29.97) to progressive frames at 29.97 fps', async () => {
    const intervals = intervalsOf('disc-mpeg2');
    const run = await encodeFrom({ ...base, sourceCoding: CodingType.MPEG2_VIDEO, input: { path: clipPath('disc-mpeg2') }, intervals, interlaced: true }, 0);
    expect([...run.intervals.keys()]).toEqual(intervals.map((iv) => iv.index));
    for (const video of run.intervals.values()) {
      const sps = analyzeAvc(esOf(video[0]!.pes)).sps;
      expect(sps).not.toBeNull();
      expect(avcIsInterlaced(sps!)).toBe(false);
      const pts = video.map((v) => ptsOf(v.pes)).sort((a, b) => a - b);
      expect(pts.length).toBe(30); // one frame per source frame, not per field
      for (let i = 1; i < pts.length; i++) expect(pts[i]! - pts[i - 1]!).toBe(3003);
    }
  }, 60_000);

  it('stop() kills ffmpeg, and nothing is emitted after it', async () => {
    const children: ChildProcess[] = [];
    const encoder = new ClipEncoder(x264Backend, {
      ...base,
      input: { path: clipPath('disc-levels') },
      intervals: intervalsOf('disc-levels'),
      spawn: recordingSpawn(children),
    });
    const seen: number[] = [];
    let ended = false;
    await new Promise<void>((resolve, reject) => {
      encoder.on('error', reject);
      encoder.on('end', () => (ended = true));
      encoder.on('interval', (index) => {
        seen.push(index);
        if (index === 1) {
          encoder.stop();
          setTimeout(resolve, 500);
        }
      });
      encoder.start(0);
    });
    expect(seen).toEqual([0, 1]);
    expect(ended).toBe(false);
    expect(children.length).toBe(1);
    expect(children[0]!.signalCode).toBe('SIGKILL');
  }, 60_000);

  it('fails a run whose ffmpeg exits 0 before the window’s last interval', async () => {
    const intervals = intervalsOf('disc-levels');
    // ffmpeg's real output for intervals 3…9, cut in the middle, played back by a stand-in that exits 0.
    const window = intervals.slice(3);
    const full = spawnSync(
      'ffmpeg',
      x264Backend.args({
        ...argsInput(level),
        file: clipPath('disc-levels'),
        startByte: window[0]!.srcSpnStart * 192,
        endByte: window.at(-1)!.srcSpnEnd * 192,
        keyframesPts90: window.map((iv) => iv.startPts45 * 2),
      }),
      { maxBuffer: 1 << 28 },
    ).stdout;
    const cut = join(scratch, 'cut.ts');
    writeFileSync(cut, full.subarray(0, Math.floor(full.length / 2 / 188) * 188));
    for (const stand of [cut, '/dev/null']) {
      const seen: number[] = [];
      const err = await new Promise<Error>((resolve, reject) => {
        const encoder = new ClipEncoder(x264Backend, { ...base, input: { path: clipPath('disc-levels') }, intervals, spawn: recordingSpawn([], { binary: 'cat', args: [stand] }) });
        encoder.on('interval', (index) => seen.push(index));
        encoder.on('error', resolve);
        encoder.on('end', () => reject(new Error('ended')));
        encoder.start(3);
      });
      expect(err.message).toMatch(/ended after interval -?\d+ of a run to 9/);
      expect(seen.every((i) => i < 9)).toBe(true);
    }
  }, 60_000);
});

describe.skipIf(!runFfmpegTests)('probeScan', () => {
  it('finds disc-mpeg2 interlaced, without soft pulldown', async () => {
    const plan = intervalsOf('disc-mpeg2');
    expect(await probeScan({ path: clipPath('disc-mpeg2') }, { startByte: plan[0]!.srcSpnStart * 192, videoPid: VIDEO })).toEqual({ interlaced: true, softPulldown: false });
  });

  it('finds disc-levels progressive (read through a reader)', async () => {
    const path = clipPath('disc-levels');
    expect(await probeScan({ read: (from) => createReadStream(path, { start: from }) }, { startByte: 0, videoPid: VIDEO })).toEqual({ interlaced: false, softPulldown: false });
  });

  it('deinterlaces interlaced video, not soft-pulldown film', () => {
    expect(deinterlaces({ interlaced: true, softPulldown: false })).toBe(true);
    expect(deinterlaces({ interlaced: true, softPulldown: true })).toBe(false);
    expect(deinterlaces({ interlaced: false, softPulldown: true })).toBe(false);
    expect(deinterlaces({ interlaced: false, softPulldown: false })).toBe(false);
  });
});

describe.skipIf(!runFfmpegTests)('encodeIntervalAt (libx264)', () => {
  const level = levelDefFor('h264-1080', { height: 1080 });
  const intervals = intervalsOf('disc-levels');
  const bytes = readFileSync(clipPath('disc-levels'));
  /** Interval 3's source for the re-muxer. */
  const source = ((): IntervalSource => {
    const streams = new KeptStreams(new Set([0x1200, 0x1201]), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]), {
      video: { pid: VIDEO, streamType: CodingType.AVC },
    });
    const collector = new IntervalCollector(streams, { videoPid: VIDEO, pcrPid: 0x1001, intervals });
    for (let spn = 0; (spn + 1) * 192 <= bytes.length; spn++) {
      collector.push(bytes.subarray(spn * 192, (spn + 1) * 192), spn);
      if (spn >= intervals[3]!.srcSpnEnd && collector.ready(intervals[3]!)) break;
    }
    for (const plan of intervals.slice(0, 3)) collector.take(plan);
    return collector.take(intervals[3]!);
  })();

  /** The options with interval 3's budget set to `budgetBytes`, a backend that records its rates, and a counting re-muxer. */
  function setup(budgetBytes: number) {
    const plan = { ...intervals[3]!, budgetBytes };
    const rates: number[] = [];
    const backend: EncoderBackend = { binary: 'ffmpeg', args: (input) => (rates.push(input.rateBps), x264Backend.args(input)) };
    const options: ClipEncoderOptions = {
      input: { path: clipPath('disc-levels') },
      intervals: intervals.map((iv) => (iv.index === 3 ? plan : iv)),
      videoPid: VIDEO,
      sourceCoding: CodingType.AVC,
      level,
      interlaced: false,
      hdr: false,
    };
    const remux = (video: readonly EncodedPes[]) =>
      remuxInterval({ plan, kept: source.kept, video, videoPid: VIDEO, videoTimeline: source.videoTimeline, pcr: null, endAts: source.endAts });
    return { options, rates, backend, remux };
  }

  it('lowers the rate by budget ÷ actual × 0.95 per try until the interval fits its budget', async () => {
    // About 2.4 Mbps for the second: 8 Mbps overflows it.
    const budget = 50 * 6144;
    const { options, rates, backend, remux } = setup(budget);
    const live = remux((await encodeFrom({ ...options, maxIntervalsPerRun: 1 }, 3)).intervals.get(3)!);
    expect('overflow' in live).toBe(true);
    const overflowBytes = (live as { overflow: number }).overflow;
    const result = await encodeIntervalAt(backend, options, 3, { rateBps: level.targetBps, overflowBytes }, remux);
    expect(rates[0]).toBe(Math.round(((level.targetBps * budget) / (budget + overflowBytes)) * 0.95));
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThan(rates[i - 1]!);
    expect(result.rateBps).toBe(rates.at(-1));
    expect(result.rateBps).toBeGreaterThanOrEqual(1_000_000);
    expect(result.bytes.length).toBe(budget);
  }, 120_000);

  it('tries once at the 1 Mbps floor, then gives up rather than serve an oversized interval', async () => {
    const { options, rates, backend, remux } = setup(6144);
    await expect(encodeIntervalAt(backend, options, 3, { rateBps: 900_000, overflowBytes: 100_000 }, remux)).rejects.toThrow(/1 Mbps/);
    expect(rates).toEqual([1_000_000]);
  }, 60_000);
});
