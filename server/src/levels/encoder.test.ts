import { spawnSync } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClpi } from '../../../src/engine/bdmv/clpi-parser';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
import { analyzeAvc, avcIsInterlaced } from '../../../src/engine/decode/h264';
import { readTimestamp } from '../../../src/engine/demux/pes-assembler';
import { parseSourcePacket } from '../../../src/engine/demux/ts-packet';
import { KeptStreams, PesCoreFilter } from './audio-core';
import { ClipEncoder, encodeIntervalAt, qsvBackend, x264Backend, type ClipEncoderOptions, type EncoderArgsInput } from './encoder';
import { levelDefFor, planClip, type IntervalPlan, type LevelDef } from './levels';
import { IntervalCollector, remuxInterval, type EncodedPes, type IntervalSource } from './remux';

const VIDEO = 0x1011;
const fixture = (disc: string): string => join(import.meta.dirname, '../../../fixtures/synthetic', disc, 'BDMV');
const clipPath = (disc: string): string => join(fixture(disc), 'STREAM/00001.m2ts');
const intervalsOf = (disc: string): IntervalPlan[] =>
  planClip(parseClpi(readFileSync(join(fixture(disc), 'CLIPINF/00001.clpi'))), levelDefFor('h264-1080', { height: 1080 }), 192_000).intervals;

const hasX264 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264') ?? false;

function argsInput(level: LevelDef, extra: Partial<EncoderArgsInput> = {}): EncoderArgsInput {
  return {
    file: '/discs/Starfall Wanderer/BDMV/STREAM/00001.m2ts',
    startByte: 1157 * 192,
    keyframesPts90: [989_696, 1_079_808, 1_169_920],
    videoPid: VIDEO,
    level,
    interlaced: false,
    hdr: false,
    rateBps: level.targetBps,
    ...extra,
  };
}

const KEYS = '10.996622,11.997866,12.999111';
const TAIL = ['-forced_idr', '1', '-force_key_frames', KEYS, '-g', '1000', '-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-mpegts_copyts', '1', '-f', 'mpegts', 'pipe:1'];
const QSV_HEAD = ['-hide_banner', '-nostats', '-loglevel', 'error', '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-copyts'];
const FILE_IN = ['-nostdin', '-skip_initial_bytes', String(1157 * 192), '-i', '/discs/Starfall Wanderer/BDMV/STREAM/00001.m2ts'];
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
    expect(qsvBackend.args(argsInput(levelDefFor('hevc-1080-hdr', { height: 2160 }), { hdr: true }))).toEqual([
      ...QSV_HEAD, ...FILE_IN, ...MAP,
      '-vf', 'scale_qsv=w=1920:h=1080:format=p010',
      '-c:v', 'hevc_qsv', '-profile:v', 'main10', '-preset', 'veryfast', '-b:v', '5000000', '-maxrate', '6250000', '-bufsize', '10000000',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
      ...TAIL,
    ]);
  });

  it('h264-1080-sdr: tone-mapped by vpp_qsv', () => {
    expect(qsvBackend.args(argsInput(levelDefFor('h264-1080-sdr', { height: 2160 }), { hdr: true }))).toEqual([
      ...QSV_HEAD, ...FILE_IN, ...MAP,
      '-vf', 'vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709',
      '-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '8000000', '-maxrate', '10000000', '-bufsize', '16000000',
      ...TAIL,
    ]);
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
    expect(args).not.toContain('-skip_initial_bytes');
    expect(args).toContain('-nostats');
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
      '-x264-params', 'keyint=1000', '-forced-idr', '1', '-force_key_frames', KEYS, '-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-mpegts_copyts', '1', '-f', 'mpegts', 'pipe:1',
    ]);
  });

  it('refuses HEVC levels', () => {
    expect(() => x264Backend.args(argsInput(levelDefFor('hevc-1080', { height: 1080 })))).toThrow(/H\.264/);
  });
});

/** The payload of a whole video PES (after its optional header). */
const esOf = (pes: Uint8Array): Uint8Array => pes.subarray(9 + pes[8]!);
const ptsOf = (pes: Uint8Array): number => readTimestamp(pes, 9);

/** The source's video PES PTS, by the SPN of their first packet. */
function sourceVideoPts(disc: string): Array<{ spn: number; pts: number }> {
  const bytes = readFileSync(clipPath(disc));
  const out: Array<{ spn: number; pts: number }> = [];
  for (let spn = 0; (spn + 1) * 192 <= bytes.length; spn++) {
    const ts = parseSourcePacket(bytes, spn * 192);
    if (!ts || ts.pid !== VIDEO || !ts.payloadUnitStart) continue;
    out.push({ spn, pts: readTimestamp(ts.payload, 9) });
  }
  return out;
}

function encodeFrom(options: ClipEncoderOptions, from: number): Promise<Map<number, EncodedPes[]>> {
  return new Promise((resolve, reject) => {
    const encoder = new ClipEncoder(x264Backend, options);
    const out = new Map<number, EncodedPes[]>();
    encoder.on('interval', (index, video) => out.set(index, video));
    encoder.on('error', reject);
    encoder.on('end', () => resolve(out));
    encoder.start(from);
  });
}

describe.skipIf(!hasX264)('ClipEncoder (libx264)', () => {
  const levels = levelDefFor('h264-1080', { height: 1080 });

  for (const input of ['path', 'reader'] as const) {
    it(`encodes disc-levels from interval 3: intervals 3…9, each opening with an IDR at its EP entry (${input})`, async () => {
      const intervals = intervalsOf('disc-levels');
      expect(intervals.length).toBe(10);
      const path = clipPath('disc-levels');
      const out = await encodeFrom(
        {
          input: input === 'path' ? { path } : { read: (from) => createReadStream(path, { start: from }) },
          intervals,
          videoPid: VIDEO,
          level: levels,
          interlaced: false,
          hdr: false,
        },
        3,
      );
      expect([...out.keys()]).toEqual([3, 4, 5, 6, 7, 8, 9]);
      const source = sourceVideoPts('disc-levels');
      for (const [index, video] of out) {
        const plan = intervals[index]!;
        const epFrame = source.find((s) => s.spn === plan.srcSpnStart)!;
        expect(Math.floor(epFrame.pts / 512) * 256).toBe(plan.startPts45);
        const first = video[0]!.pes;
        expect(ptsOf(first)).toBe(epFrame.pts);
        expect(analyzeAvc(esOf(first)).idr).toBe(true);
        expect(video.slice(1).some((v) => analyzeAvc(esOf(v.pes)).idr)).toBe(false);
        // The source's frames of this interval, every one, in display order.
        const want = source.filter((s) => s.spn >= plan.srcSpnStart && s.spn < plan.srcSpnEnd).map((s) => s.pts);
        expect(video.map((v) => ptsOf(v.pes)).sort((a, b) => a - b)).toEqual(want);
        // Decode order: the DTS never goes back.
        for (let i = 1; i < video.length; i++) expect(video[i]!.dts90).toBeGreaterThan(video[i - 1]!.dts90);
      }
    }, 60_000);
  }

  it('deinterlaces disc-mpeg2 (1080i29.97) to progressive frames at 29.97 fps', async () => {
    const intervals = intervalsOf('disc-mpeg2');
    const out = await encodeFrom({ input: { path: clipPath('disc-mpeg2') }, intervals, videoPid: VIDEO, level: levels, interlaced: true, hdr: false }, 0);
    expect([...out.keys()]).toEqual(intervals.map((iv) => iv.index));
    for (const video of out.values()) {
      const sps = analyzeAvc(esOf(video[0]!.pes)).sps;
      expect(sps).not.toBeNull();
      expect(avcIsInterlaced(sps!)).toBe(false);
      const pts = video.map((v) => ptsOf(v.pes)).sort((a, b) => a - b);
      expect(pts.length).toBe(30); // one frame per source frame, not per field
      for (let i = 1; i < pts.length; i++) expect(pts[i]! - pts[i - 1]!).toBe(3003);
    }
  }, 60_000);

  it('emits nothing after stop()', async () => {
    const encoder = new ClipEncoder(x264Backend, {
      input: { path: clipPath('disc-levels') },
      intervals: intervalsOf('disc-levels'),
      videoPid: VIDEO,
      level: levels,
      interlaced: false,
      hdr: false,
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
  }, 60_000);
});

describe.skipIf(!hasX264)('encodeIntervalAt (libx264)', () => {
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
  const options: ClipEncoderOptions = { input: { path: clipPath('disc-levels') }, intervals, videoPid: VIDEO, level, interlaced: false, hdr: false };

  /** The re-mux of interval 3 into a budget of `budgetBytes`, counting its calls. */
  function remuxer(budgetBytes: number): { calls: number; remux: (video: readonly EncodedPes[]) => ReturnType<typeof remuxInterval> } {
    const plan = { ...intervals[3]!, budgetBytes };
    const self = {
      calls: 0,
      remux: (video: readonly EncodedPes[]) => {
        self.calls++;
        return remuxInterval({ plan, kept: source.kept, video, videoPid: VIDEO, videoTimeline: source.videoTimeline, pcr: null, endAts: source.endAts });
      },
    };
    return self;
  }

  it('lowers the rate by 0.8 per try until the interval fits its budget', async () => {
    // About 2.4 Mbps for the second: 8 Mbps overflows it, and so do the first few tries.
    const budget = 50 * 6144;
    const r = remuxer(budget);
    expect('overflow' in r.remux((await encodeFrom(options, 3)).get(3)!)).toBe(true);
    r.calls = 0;
    const result = await encodeIntervalAt(x264Backend, options, 3, level.targetBps, r.remux);
    expect(r.calls).toBeGreaterThan(1);
    expect(result.rateBps).toBe(Math.round(level.targetBps * 0.8 ** r.calls));
    expect(result.rateBps).toBeGreaterThanOrEqual(1_000_000);
    expect(result.bytes.length).toBe(budget);
  }, 120_000);

  it('gives up at the 1 Mbps floor rather than serve an oversized interval', async () => {
    const r = remuxer(6144);
    await expect(encodeIntervalAt(x264Backend, options, 3, 1_500_000, r.remux)).rejects.toThrow(/1 Mbps/);
    // 1.2 Mbps, then the floor.
    expect(r.calls).toBe(2);
  }, 60_000);
});
