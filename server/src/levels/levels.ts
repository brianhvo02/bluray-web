import type { Clpi, EpMap } from '../../../src/engine/bdmv/clpi-parser';
import { CodingType, isVideoCoding } from '../../../src/engine/bdmv/stream-types';

/** The quality levels a disc can be served at; `original` is the disc's own bytes. */
export type LevelId = 'original' | 'h264-1080' | 'phone-720' | 'hevc-1080' | 'hevc-1080-hdr' | 'h264-1080-sdr';

export interface LevelDef {
  readonly id: Exclude<LevelId, 'original'>;
  readonly codec: 'h264' | 'hevc';
  readonly width: number;
  readonly height: number;
  /** The encoder's target rate, bits per second. */
  readonly targetBps: number;
  /** The encoder's maxrate (1.25 × target), which the byte budget is sized for. */
  readonly peakBps: number;
  /** HEVC Main10 with the source's HDR10 metadata kept. */
  readonly hdr: boolean;
  /** HDR source tone-mapped to SDR. */
  readonly tonemap: boolean;
}

const PEAK_FACTOR = 1.25;

function level(id: LevelDef['id'], codec: LevelDef['codec'], height: 720 | 1080, targetBps: number, hdr = false, tonemap = false): LevelDef {
  const width = height === 720 ? 1280 : 1920;
  return { id, codec, width, height, targetBps, peakBps: targetBps * PEAK_FACTOR, hdr, tonemap };
}

export const LEVELS: Readonly<Record<Exclude<LevelId, 'original'>, LevelDef>> = {
  'h264-1080': level('h264-1080', 'h264', 1080, 8_000_000),
  'phone-720': level('phone-720', 'h264', 720, 3_000_000),
  'hevc-1080': level('hevc-1080', 'hevc', 1080, 5_000_000),
  'hevc-1080-hdr': level('hevc-1080-hdr', 'hevc', 1080, 5_000_000, true),
  'h264-1080-sdr': level('h264-1080-sdr', 'h264', 1080, 8_000_000, false, true),
};

/** Video no browser decodes, so a disc with it never plays at `original` (ruling L-R1). */
const UNPLAYABLE_VIDEO = new Set<number>([CodingType.MPEG1_VIDEO, CodingType.MPEG2_VIDEO, CodingType.VC1]);

/** The levels a disc's primary video can be served at, best first. */
export function levelsFor(source: { codingType: number; height: number; hdr: boolean }): LevelId[] {
  const original: LevelId[] = UNPLAYABLE_VIDEO.has(source.codingType) ? [] : ['original'];
  if (source.hdr) return [...original, 'hevc-1080-hdr', 'h264-1080-sdr'];
  if (source.height <= 720) return [...original, 'phone-720'];
  return [...original, 'h264-1080', 'hevc-1080', 'phone-720'];
}

/** BD video_format codes (libbluray bluray.h, bd_video_format_e). */
const VIDEO_FORMAT_720P = 5;
const VIDEO_FORMAT_1080P = 6;

/**
 * The primary video's coding attributes at a level. The frame-rate code is the source's: an
 * interlaced source is deinterlaced to its frame rate, so 1080i 29.97 (rate 4) becomes 1080p 29.97.
 */
export function videoAttrsFor(level: LevelDef, sourceRate: number): { newCoding: number; newFormat: number; newRate: number } {
  return {
    newCoding: level.codec === 'h264' ? CodingType.AVC : CodingType.HEVC,
    newFormat: level.height === 720 ? VIDEO_FORMAT_720P : VIDEO_FORMAT_1080P,
    newRate: sourceRate,
  };
}

/**
 * The coding type of what a level carries for a kept audio stream: TrueHD travels as its AC-3
 * substream, DTS-HD as its DTS core; everything else as it is.
 */
export function coreCoding(codingType: number): number {
  if (codingType === CodingType.TRUEHD) return CodingType.AC3;
  if (codingType === CodingType.DTSHD || codingType === CodingType.DTSHD_MASTER) return CodingType.DTS;
  return codingType;
}

/** BD audio sample-rate code for 48 kHz, the rate of every AC-3 and DTS core. */
export const AUDIO_RATE_48K = 1;

/**
 * The level's TS_recording_rate, bytes per second: the highest rate any interval's budget
 * stands for (budget ÷ duration), rounded up.
 */
export function maxBudgetRate(intervals: readonly IntervalPlan[]): number {
  let max = 0;
  for (const iv of intervals) {
    const duration = iv.endPts45 - iv.startPts45;
    if (duration > 0) max = Math.max(max, Math.ceil((iv.budgetBytes * PTS45_HZ) / duration));
  }
  return max;
}

/** One EP interval of a clip: the bytes from one video EP entry to the next, and its place at a level. */
export interface IntervalPlan {
  readonly index: number;
  /** 45 kHz, the EP entry's PTS. */
  readonly startPts45: number;
  /** 45 kHz, the next entry's PTS (or the STC sequence's end), unwrapped: always after `startPts45`. */
  readonly endPts45: number;
  /** Source packets [srcSpnStart, srcSpnEnd) of the original clip; the first interval starts at 0. */
  readonly srcSpnStart: number;
  readonly srcSpnEnd: number;
  /** The interval's bytes at the level, a whole number of aligned units. */
  readonly budgetBytes: number;
  /** The interval's first source packet at the level: the running total of budgets ÷ 192. */
  readonly spnStart: number;
}

/** 32 source packets, the aligned unit of an m2ts file. */
export const ALIGNED_UNIT_BYTES = 6144;
export const SOURCE_PACKET_BYTES = 192;
/** Room for every PG and IG stream, which travel bit-exact. */
export const GRAPHICS_ALLOWANCE_BPS = 1_500_000;
const PTS45_WRAP = 2 ** 32;
const PTS45_HZ = 45_000;

/** The EP map of a clip's primary video: the first video stream of the first program that has one. */
export function videoEpMap(clpi: Clpi): EpMap | undefined {
  for (const program of clpi.programs) {
    for (const s of program.streams) {
      if (!isVideoCoding(s.codingType)) continue;
      const map = clpi.epMaps.find((m) => m.pid === s.pid);
      if (map) return map;
    }
  }
  return undefined;
}

/** The STC sequence's presentation end for a source packet, or undefined. */
function stcEndAt(clpi: Clpi, spn: number): { index: number; end: number } | undefined {
  let found: { index: number; end: number } | undefined;
  let index = 0;
  for (const atc of clpi.atcSequences) {
    for (const stc of atc.stc) {
      if (stc.spnStcStart <= spn) found = { index, end: stc.presentationEnd };
      index++;
    }
  }
  return found;
}

/** Byte budget for `duration45` ticks at `bps`, rounded up to an aligned unit; never empty. */
function budgetFor(duration45: number, bps: number): number {
  const units = Math.ceil((duration45 * bps) / (PTS45_HZ * 8 * ALIGNED_UNIT_BYTES));
  return Math.max(1, units) * ALIGNED_UNIT_BYTES;
}

/**
 * Splits a clip into EP intervals and gives each a byte budget at the level:
 * ⌈duration × (video peak + audio + graphics allowance) ÷ 8 ÷ 6144⌉ × 6144 bytes.
 */
export function planClip(clpi: Clpi, level: LevelDef, audioBps: number): { intervals: IntervalPlan[]; sizeBytes: number } {
  const map = videoEpMap(clpi);
  if (!map || map.entries.length === 0) throw new Error('levels: the clip has no video EP map');
  const bps = level.peakBps + audioBps + GRAPHICS_ALLOWANCE_BPS;
  const entries = map.entries;
  const intervals: IntervalPlan[] = [];
  let total = 0;
  entries.forEach((e, i) => {
    const next = entries[i + 1];
    const stc = stcEndAt(clpi, e.spn);
    const nextStc = next ? stcEndAt(clpi, next.spn) : undefined;
    const endRaw = next && nextStc?.index === stc?.index ? next.pts : (stc?.end ?? e.pts);
    const duration = (endRaw - e.pts + PTS45_WRAP) % PTS45_WRAP;
    const budgetBytes = budgetFor(duration, bps);
    intervals.push({
      index: i,
      startPts45: e.pts,
      endPts45: e.pts + duration,
      srcSpnStart: i === 0 ? 0 : e.spn,
      srcSpnEnd: next ? next.spn : clpi.numSourcePackets,
      budgetBytes,
      spnStart: total / SOURCE_PACKET_BYTES,
    });
    total += budgetBytes;
  });
  return { intervals, sizeBytes: total };
}

/**
 * Where a source packet number lands at the level: the first interval starting at or after it
 * (the end of the clip past the last). Used for sequence and program starts, so EP entries before
 * an STC change stay out of the new sequence's range.
 */
export function mapSpn(intervals: readonly IntervalPlan[], srcSpn: number): number {
  for (const iv of intervals) if (iv.srcSpnStart >= srcSpn) return iv.spnStart;
  const last = intervals.at(-1);
  return last ? last.spnStart + last.budgetBytes / SOURCE_PACKET_BYTES : 0;
}

/** The interval holding a source packet number, at the level: the start of the interval containing it. */
export function mapSpnDown(intervals: readonly IntervalPlan[], srcSpn: number): number {
  let spn = 0;
  for (const iv of intervals) {
    if (iv.srcSpnStart > srcSpn) break;
    spn = iv.spnStart;
  }
  return spn;
}
