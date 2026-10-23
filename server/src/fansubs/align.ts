/**
 * Lines a fansub track up with the disc's own audio: where the track's dialogue says speech is, against where the disc's
 * speech mask finds it. Never a confident wrong answer: when unsure the result is `none`, and the owner sets the episode
 * by hand. Original code.
 */
import type { FansubAlignment } from '../../../src/engine/disc/nas-api';
import type { LevelDiscSource } from '../levels/level-discs';
import { dialogueIntervals } from './dialogue';
import { episodeAudio, windowsFor, type AudioWindow, type TimeWindow } from './disc-audio';
import { speechMask } from './speech';

type Span = { readonly fromMs: number; readonly toMs: number };

export interface AlignInput {
  readonly windows: readonly AudioWindow[];
  readonly dialogue: readonly Span[];
}

export interface WindowOffset {
  readonly startMs: number;
  readonly offsetMs: number;
  readonly score: number;
}

const FRAME_MS = 10;
/** An offset whose shifted dialogue covers less than this much of a window scores 0 there: too little to judge by. */
const MIN_JUDGED_FRAMES = 300;
const RELIABLE_SCORE = 0.4;
const AGREE_MS = 300;
const CONFIDENT_SCORE = 0.55;
const CONFIDENT_MARGIN = 0.1;
/** The margin is over the best offset more than this far from the winner. */
const MARGIN_AWAY_MS = 1000;
const SPLIT_GAIN = 0.08;
const SPLIT_STEP_MS = 1000;
const MAX_SPLITS = 3;
/** Least dialogue to line up on, for a whole track and for each part of a split. */
const MIN_INTERVALS = 20;
const MIN_DIALOGUE_MS = 30_000;
/** A window whose mask is quieter than this while dialogue falls in it is unusable (the mask goes quiet on near-solid speech). */
const MIN_SPEECH_SHARE = 0.02;
const MIN_PRESENT_DIALOGUE_MS = 2000;
/** The stretches a single whole-episode window is cut into to see whether its parts agree. */
const SLICE_MS = 30_000;
/** Of the sampled windows tried, at least this many (or all of them, when fewer were tried) must decode usably. */
const MIN_USABLE_WINDOWS = 3;
/** A split's alternatives within this of the best score count as equal, and the one with fewer splits wins. */
const SPLIT_TIE = 0.02;

const NO_SPEECH: FansubAlignment = { kind: 'none', reason: 'no-speech' };
const LOW: FansubAlignment = { kind: 'none', reason: 'low-confidence' };

interface Masked {
  readonly startMs: number;
  readonly mask: Uint8Array;
  /** prefix[f] = speech frames in mask[0, f). */
  readonly prefix: Uint32Array;
}

function masked(window: AudioWindow): Masked {
  const mask = speechMask(window);
  const prefix = new Uint32Array(mask.length + 1);
  for (let f = 0; f < mask.length; f++) prefix[f + 1] = prefix[f]! + mask[f]!;
  return { startMs: window.startMs, mask, prefix };
}

/** Matched speech frames and dialogue frames, per offset: index k is offset (k - maxShift / 10) × 10 ms. */
interface Curve {
  readonly matched: Float64Array;
  readonly total: Float64Array;
  readonly half: number;
}

/**
 * How the dialogue lines up with the window's mask at every offset of the grid: each interval, moved by the offset and
 * clipped to the window, adds its frames to `total` and the speech frames under it (from the prefix sums) to `matched`.
 * O(intervals) per offset.
 */
function curve(w: Masked, dialogue: readonly Span[], maxShiftMs: number): Curve {
  const half = Math.round(maxShiftMs / FRAME_MS);
  const frames = w.mask.length;
  const endMs = w.startMs + frames * FRAME_MS;
  const near = dialogue.filter((d) => d.toMs + maxShiftMs > w.startMs && d.fromMs - maxShiftMs < endMs);
  const from = near.map((d) => (d.fromMs - w.startMs) / FRAME_MS);
  const to = near.map((d) => (d.toMs - w.startMs) / FRAME_MS);
  const matched = new Float64Array(2 * half + 1);
  const total = new Float64Array(2 * half + 1);
  const { prefix } = w;
  for (let k = 0; k <= 2 * half; k++) {
    const shift = k - half;
    let m = 0;
    let t = 0;
    for (let i = 0; i < near.length; i++) {
      const a = Math.min(frames, Math.max(0, Math.round(from[i]! + shift)));
      const b = Math.min(frames, Math.max(0, Math.round(to[i]! + shift)));
      if (b <= a) continue;
      m += prefix[b]! - prefix[a]!;
      t += b - a;
    }
    matched[k] = m;
    total[k] = t;
  }
  return { matched, total, half };
}

function ratio(c: Curve, k: number): number {
  const t = c.total[k]!;
  return t >= MIN_JUDGED_FRAMES ? c.matched[k]! / t : 0;
}

/**
 * The best offset, its score, and its margin over the best offset more than 1 s away. The score is flat across a run of
 * offsets wherever the dialogue's lines are longer or shorter than the speech under them: the middle of the run is taken
 * (of the run nearest 0, when several score the same).
 */
function best(c: Curve): { offsetMs: number; score: number; margin: number } {
  let top = -1;
  for (let k = 0; k < c.matched.length; k++) top = Math.max(top, ratio(c, k));
  let bestK = -1;
  for (let k = 0; k < c.matched.length; k++) {
    if (ratio(c, k) < top) continue;
    let end = k;
    while (end + 1 < c.matched.length && ratio(c, end + 1) >= top) end++;
    const mid = (k + end) >> 1;
    if (bestK < 0 || Math.abs(mid - c.half) < Math.abs(bestK - c.half)) bestK = mid;
    k = end;
  }
  return { offsetMs: (bestK - c.half) * FRAME_MS, score: top, margin: marginAt(c, bestK) };
}

function marginAt(c: Curve, k: number): number {
  const away = MARGIN_AWAY_MS / FRAME_MS;
  let rival = 0;
  for (let j = 0; j < c.matched.length; j++) if (Math.abs(j - k) > away) rival = Math.max(rival, ratio(c, j));
  return ratio(c, k) - rival;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const m = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(m / FRAME_MS) * FRAME_MS;
}

function windowsAligned(windows: readonly Masked[], dialogue: readonly Span[], maxShiftMs: number) {
  const curves = windows.map((w) => curve(w, dialogue, maxShiftMs));
  const perWindow = curves.map((c, i) => {
    const b = best(c);
    return { startMs: windows[i]!.startMs, offsetMs: b.offsetMs, score: b.score };
  });
  const reliable = perWindow.filter((w) => w.score >= RELIABLE_SCORE).map((w) => w.offsetMs);
  const mid = reliable.length ? median(reliable) : 0;
  const agree = reliable.every((o) => Math.abs(o - mid) <= AGREE_MS);
  return { curves, perWindow, agree, reliable, mid };
}

/**
 * Per window, the offset in [-maxShiftMs, maxShiftMs] (10 ms steps) at which the dialogue, moved by it, best covers the
 * window's speech: the score is the speech frames under the moved dialogue over the dialogue frames in the window.
 * `agree` when every window scoring 0.4 or more is within 300 ms of their median.
 */
export function alignWindows(input: AlignInput, maxShiftMs = 60_000): { readonly perWindow: readonly WindowOffset[]; readonly agree: boolean } {
  const { perWindow, agree } = windowsAligned(input.windows.map(masked), input.dialogue, maxShiftMs);
  return { perWindow, agree };
}

/** Confident when the score is at least 0.55 and beats the best offset more than 1 s away by at least 0.1. */
export function decide(score: number, margin: number): 'confident' | 'low' {
  return score >= CONFIDENT_SCORE && margin >= CONFIDENT_MARGIN ? 'confident' : 'low';
}

/** Cuts a window into consecutive pieces of `lengthMs` (the last one shorter). */
export function sliceWindow(window: AudioWindow, lengthMs: number): AudioWindow[] {
  const step = lengthMs * 16;
  const pieces: AudioWindow[] = [];
  for (let at = 0; at < window.pcm.length; at += step) {
    pieces.push({ startMs: window.startMs + at / 16, pcm: window.pcm.subarray(at, Math.min(window.pcm.length, at + step)) });
  }
  return pieces;
}

/** The sampled windows agreed: their summed curve at the median decides. */
function agreedVerdict(curves: readonly Curve[], mid: number): FansubAlignment {
  const half = curves[0]!.half;
  const sum: Curve = { matched: new Float64Array(2 * half + 1), total: new Float64Array(2 * half + 1), half };
  for (const c of curves) {
    for (let k = 0; k < c.matched.length; k++) {
      sum.matched[k] += c.matched[k]!;
      sum.total[k] += c.total[k]!;
    }
  }
  const k = half + mid / FRAME_MS;
  const score = ratio(sum, k);
  if (decide(score, marginAt(sum, k)) !== 'confident') return LOW;
  return { kind: 'offset', offsetMs: mid, confidence: round2(score) };
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

const spanMs = (spans: readonly Span[]): number => spans.reduce((sum, s) => sum + (s.toMs - s.fromMs), 0);

/**
 * With the whole episode in `input.windows[0]`: the best single offset, then up to three split points, each placed in the
 * stretch around a pair of neighbouring windows (of `perWindow`) that disagree and searched there at 1 s steps; a split is
 * taken only when it raises the score by 0.08 or more, and each of its parts must be confident on its own.
 * Split points and `parts[].fromMs` are in the track's time.
 */
export function alignWhole(input: AlignInput, perWindow: readonly WindowOffset[], maxShiftMs = 60_000): FansubAlignment {
  const w = masked(input.windows[0]!);
  const dialogue = input.dialogue;
  const single = best(curve(w, dialogue, maxShiftMs));
  const singleVerdict = (): FansubAlignment =>
    decide(single.score, single.margin) === 'confident' ? { kind: 'offset', offsetMs: single.offsetMs, confidence: round2(single.score) } : LOW;

  const n = dialogue.length;
  const reliable = [...perWindow].filter((p) => p.score >= RELIABLE_SCORE).sort((a, b) => a.startMs - b.startMs);
  const pairs: { lo: number; hi: number; gap: number }[] = [];
  for (let i = 0; i + 1 < reliable.length; i++) {
    const a = reliable[i]!;
    const b = reliable[i + 1]!;
    if (Math.abs(a.offsetMs - b.offsetMs) <= AGREE_MS) continue;
    // The cut lies somewhere in window a or window b, which reach at most to the window after b.
    const endMs = reliable[i + 2]?.startMs ?? w.startMs + w.mask.length * FRAME_MS;
    pairs.push({ lo: a.startMs - Math.max(a.offsetMs, b.offsetMs), hi: endMs - Math.min(a.offsetMs, b.offsetMs), gap: Math.abs(a.offsetMs - b.offsetMs) });
  }
  if (!pairs.length || n < 2 * MIN_INTERVALS) return singleVerdict();
  const ranges = pairs.sort((a, b) => b.gap - a.gap).slice(0, MAX_SPLITS).sort((a, b) => a.lo - b.lo);

  // A split point at track time s puts the intervals starting before s in the earlier part: points are interval indices.
  const before = (s: number): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dialogue[mid]!.fromMs < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const points = ranges.map((r) => {
    const ks = new Set<number>();
    for (let s = Math.max(0, r.lo); s <= r.hi; s += SPLIT_STEP_MS) {
      const k = before(s);
      if (k >= MIN_INTERVALS && n - k >= MIN_INTERVALS) ks.add(k);
    }
    return [...ks].sort((a, b) => a - b);
  });

  // Each part's offset comes from the windows' own offsets and the single best one; refined over the full range after.
  const offsets = [...new Set([single.offsetMs, ...reliable.map((p) => p.offsetMs)])];
  const frames = w.mask.length;
  const cumulative = offsets.map((o) => {
    const c = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const a = Math.min(frames, Math.max(0, Math.round((dialogue[i]!.fromMs + o - w.startMs) / FRAME_MS)));
      const b = Math.min(frames, Math.max(0, Math.round((dialogue[i]!.toMs + o - w.startMs) / FRAME_MS)));
      c[i + 1] = c[i]! + (b > a ? w.prefix[b]! - w.prefix[a]! : 0);
    }
    return c;
  });
  const part = (a: number, b: number): number => {
    let m = 0;
    for (const c of cumulative) m = Math.max(m, c[b]! - c[a]!);
    return m;
  };

  type Candidate = { score: number; parts: { fromMs: number; offsetMs: number; score: number; margin: number }[] };
  const candidates: Candidate[] = [];
  for (let subset = 1; subset < 1 << ranges.length; subset++) {
    const chosen = points.filter((_, j) => subset & (1 << j));
    if (chosen.some((p) => !p.length)) continue;
    // Best split points for this subset, in order, each part at least MIN_INTERVALS long.
    let layer = new Map<number, { value: number; path: number[] }>([[0, { value: 0, path: [] }]]);
    for (const ks of chosen) {
      const next = new Map<number, { value: number; path: number[] }>();
      for (const k of ks) {
        for (const [prev, state] of layer) {
          if (k - prev < MIN_INTERVALS) continue;
          const value = state.value + part(prev, k);
          if (!next.has(k) || value > next.get(k)!.value) next.set(k, { value, path: [...state.path, k] });
        }
      }
      layer = next;
    }
    let path: number[] | null = null;
    let top = -1;
    for (const [prev, state] of layer) {
      if (n - prev < MIN_INTERVALS) continue;
      const value = state.value + part(prev, n);
      if (value > top) {
        top = value;
        path = state.path;
      }
    }
    if (!path) continue;

    const bounds = [0, ...path, n];
    const parts: Candidate['parts'] = [];
    let matched = 0;
    let total = 0;
    let valid = true;
    for (let j = 0; j + 1 < bounds.length; j++) {
      const spans = dialogue.slice(bounds[j], bounds[j + 1]);
      if (spanMs(spans) < MIN_DIALOGUE_MS) valid = false;
      const c = curve(w, spans, maxShiftMs);
      const b = best(c);
      const k = c.half + b.offsetMs / FRAME_MS;
      matched += c.matched[k]!;
      total += c.total[k]!;
      const at = bounds[j]!;
      const fromMs = at === 0 ? 0 : Math.round((dialogue[at - 1]!.toMs + dialogue[at]!.fromMs) / 2 / FRAME_MS) * FRAME_MS;
      const prev = parts[parts.length - 1];
      if (prev && Math.abs(prev.offsetMs - b.offsetMs) <= AGREE_MS) valid = false; // not a cut
      parts.push({ fromMs, offsetMs: b.offsetMs, score: b.score, margin: b.margin });
    }
    if (valid && total > 0) candidates.push({ score: matched / total, parts });
  }
  if (!candidates.length) return singleVerdict();
  const top = Math.max(...candidates.map((c) => c.score));
  const pick = candidates
    .filter((c) => c.score >= top - SPLIT_TIE)
    .sort((a, b) => a.parts.length - b.parts.length || b.score - a.score)[0]!;
  if (pick.score < single.score + SPLIT_GAIN) return singleVerdict();
  // The split fits clearly better than one offset: the single offset is wrong, so an unsure split is no answer at all.
  if (pick.parts.some((p) => decide(p.score, p.margin) !== 'confident')) return LOW;
  return { kind: 'split', parts: pick.parts.map(({ fromMs, offsetMs }) => ({ fromMs, offsetMs })), confidence: round2(pick.score) };
}

export interface AlignOptions {
  /** The sampled windows, instead of `windowsFor(durationMs)` (tests). */
  readonly windows?: readonly TimeWindow[];
}

/** The windows' audio, or null when they could not be read; an abort rejects. */
async function read(disc: LevelDiscSource, playlistId: string, spans: readonly TimeWindow[] | 'whole', ffmpegPath: string, signal?: AbortSignal): Promise<AudioWindow | null> {
  try {
    const [w] = await episodeAudio(disc, playlistId, spans, ffmpegPath, signal);
    return w ?? null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/** A window is unusable when the dialogue says there is speech in it but its mask found almost none. */
function usable(w: Masked, dialogue: readonly Span[]): boolean {
  const endMs = w.startMs + w.mask.length * FRAME_MS;
  let present = 0;
  for (const d of dialogue) present += Math.max(0, Math.min(d.toMs, endMs) - Math.max(d.fromMs, w.startMs));
  if (present < MIN_PRESENT_DIALOGUE_MS) return true;
  return w.prefix[w.mask.length]! >= MIN_SPEECH_SHARE * w.mask.length;
}

/**
 * Lines a track (`ass`) up with a playlist's audio: sampled windows first, and the whole episode when they disagree
 * (an episode short enough to be one window is read whole at once, and cut into 30 s stretches to compare).
 * A window that can't be read, or whose speech mask went quiet, is skipped; too few left is `low-confidence`.
 */
export async function align(
  disc: LevelDiscSource,
  playlistId: string,
  durationMs: number,
  ass: string,
  ffmpegPath: string,
  signal?: AbortSignal,
  options: AlignOptions = {},
): Promise<FansubAlignment> {
  const dialogue = dialogueIntervals(ass);
  if (dialogue.length < MIN_INTERVALS || spanMs(dialogue) < MIN_DIALOGUE_MS) return NO_SPEECH;
  signal?.throwIfAborted();
  const spans = options.windows ?? windowsFor(durationMs);

  if (spans.length === 1 && spans[0]!.fromMs <= 0 && spans[0]!.toMs >= durationMs) {
    const whole = await read(disc, playlistId, 'whole', ffmpegPath, signal);
    if (!whole || !usable(masked(whole), dialogue)) return LOW;
    const slices = sliceWindow(whole, SLICE_MS).map(masked).filter((s) => usable(s, dialogue));
    const sampled = windowsAligned(slices, dialogue, 60_000);
    if (sampled.agree) return sampled.reliable.length ? agreedVerdict(sampled.curves, sampled.mid) : LOW;
    return alignWhole({ windows: [whole], dialogue }, sampled.perWindow);
  }

  const windows: Masked[] = [];
  for (const span of spans) {
    const w = await read(disc, playlistId, [span], ffmpegPath, signal);
    if (!w) continue;
    const m = masked(w);
    if (usable(m, dialogue)) windows.push(m);
  }
  if (windows.length < Math.min(MIN_USABLE_WINDOWS, spans.length)) return LOW;
  const sampled = windowsAligned(windows, dialogue, 60_000);
  if (sampled.agree) return sampled.reliable.length ? agreedVerdict(sampled.curves, sampled.mid) : LOW;
  const whole = await read(disc, playlistId, 'whole', ffmpegPath, signal);
  if (!whole) return LOW;
  return alignWhole({ windows: [whole], dialogue }, sampled.perWindow);
}
