import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEECH_BURSTS } from '../../../tests/helpers/speech-bursts';
import { folderDiscSource } from '../levels/level-discs';
import { align, alignWhole, alignWindows, decide, sliceWindow } from './align';
import { episodeAudio, type AudioWindow } from './disc-audio';
import { dialogueIntervals } from './dialogue';

const hasAc3 = spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' }).stdout?.includes(' ac3 ') ?? false;
/** CI installs ffmpeg: there, a missing AC-3 decoder fails these tests instead of skipping them. */
const runFfmpegTests = hasAc3 || Boolean(process.env.CI);

const disc = folderDiscSource(join(import.meta.dirname, '../../../fixtures/synthetic/disc-speech'), { id: 'speech', name: 'Speech' });
const DURATION_MS = 150_000;

const HEAD = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: Signs,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function time(ms: number): string {
  const cs = Math.round(ms / 10);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${p2(Math.floor(cs / 6000) % 60)}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
}

/** An ASS script with one event per span, each moved by `shift(span)`. */
function script(spans: readonly { fromMs: number; toMs: number }[], shift: (fromMs: number) => number = () => 0, style = 'Default'): string {
  return HEAD + spans.map((s, i) => `Dialogue: 0,${time(s.fromMs + shift(s.fromMs))},${time(s.toMs + shift(s.fromMs))},${style},,0,0,0,,Line ${i}\n`).join('');
}

/** Spans at made-up times that have nothing to do with the bursts (a fixed seed). */
function unrelatedSpans(): { fromMs: number; toMs: number }[] {
  let seed = 7;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const spans: { fromMs: number; toMs: number }[] = [];
  let at = 500;
  while (spans.length < 32) {
    const len = 1000 + Math.round(rnd() * 150) * 10;
    spans.push({ fromMs: at, toMs: at + len });
    at += len + 500 + Math.round(rnd() * 250) * 10;
  }
  return spans;
}

/** A window of quiet noise with loud noise at `bursts` (window-relative ms). */
function noiseWindow(startMs: number, seconds: number, bursts: readonly { fromMs: number; toMs: number }[]): AudioWindow {
  const pcm = new Int16Array(seconds * 16000);
  let seed = startMs + 1;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(rnd() * 20);
  for (const b of bursts) {
    for (let i = Math.max(0, (b.fromMs - startMs) * 16); i < Math.min(pcm.length, (b.toMs - startMs) * 16); i++) pcm[i] = Math.round(rnd() * 12000);
  }
  return { startMs, pcm };
}

const moved = (ms: number) => SPEECH_BURSTS.map((b) => ({ fromMs: b.fromMs + ms, toMs: b.toMs + ms }));

describe('alignWindows', () => {
  it('agrees when two windows find the same offset', () => {
    // The disc's speech is 500 ms later than the dialogue: offset +500.
    const windows = [noiseWindow(10_000, 30, moved(500)), noiseWindow(80_000, 30, moved(500))];
    const { perWindow, agree } = alignWindows({ windows, dialogue: SPEECH_BURSTS });
    expect(agree).toBe(true);
    for (const w of perWindow) {
      expect(Math.abs(w.offsetMs - 500)).toBeLessThanOrEqual(20);
      expect(w.score).toBeGreaterThan(0.9);
    }
  });

  it('disagrees when one window is at +500 ms and another at -1500 ms', () => {
    const windows = [noiseWindow(10_000, 30, moved(500)), noiseWindow(80_000, 30, moved(-1500))];
    const { perWindow, agree } = alignWindows({ windows, dialogue: SPEECH_BURSTS });
    expect(agree).toBe(false);
    expect(Math.abs(perWindow[0].offsetMs - 500)).toBeLessThanOrEqual(20);
    expect(Math.abs(perWindow[1].offsetMs + 1500)).toBeLessThanOrEqual(20);
  });
});

describe('decide', () => {
  it('is confident only with a high score and a clear margin', () => {
    expect(decide(0.8, 0.3)).toBe('confident');
    expect(decide(0.55, 0.1)).toBe('confident');
    expect(decide(0.54, 0.3)).toBe('low');
    expect(decide(0.9, 0.09)).toBe('low');
  });
});

describe.skipIf(!runFfmpegTests)('align', () => {
  it('finds a known offset', async () => {
    const result = await align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS, () => 1230), 'ffmpeg');
    expect(result.kind).toBe('offset');
    if (result.kind !== 'offset') return;
    expect(Math.abs(result.offsetMs + 1230)).toBeLessThanOrEqual(20);
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('finds zero', async () => {
    const result = await align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS), 'ffmpeg');
    expect(result.kind).toBe('offset');
    if (result.kind !== 'offset') return;
    expect(Math.abs(result.offsetMs)).toBeLessThanOrEqual(20);
  });

  const splitAss = script(SPEECH_BURSTS, (fromMs) => (fromMs >= 70_000 ? 2000 : 0));
  const expectSplit = (result: Awaited<ReturnType<typeof align>>): void => {
    expect(result.kind).toBe('split');
    if (result.kind !== 'split') return;
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0].fromMs).toBe(0);
    expect(Math.abs(result.parts[0].offsetMs)).toBeLessThanOrEqual(20);
    expect(Math.abs(result.parts[1].offsetMs + 2000)).toBeLessThanOrEqual(20);
    expect(Math.abs(result.parts[1].fromMs - 72_000)).toBeLessThanOrEqual(5000);
  };

  it('finds a split (alignWhole on the whole episode)', async () => {
    const [whole] = await episodeAudio(disc, '00000', 'whole', 'ffmpeg');
    const dialogue = dialogueIntervals(splitAss);
    const { perWindow, agree } = alignWindows({ windows: sliceWindow(whole, 30_000), dialogue });
    expect(agree).toBe(false);
    expectSplit(alignWhole({ windows: [whole], dialogue }, perWindow));
  });

  it('finds a split (align, sampled windows that disagree, then the whole episode)', async () => {
    const windows = [0, 30_000, 60_000, 90_000, 120_000].map((fromMs) => ({ fromMs, toMs: fromMs + 30_000 }));
    expectSplit(await align(disc, '00000', DURATION_MS, splitAss, 'ffmpeg', undefined, { windows }));
  });

  it('finds a split (align, an episode short enough to be one window)', async () => {
    expectSplit(await align(disc, '00000', DURATION_MS, splitAss, 'ffmpeg'));
  });

  it('refuses signs only', async () => {
    const signs = SPEECH_BURSTS.slice(0, 5);
    expect(await align(disc, '00000', DURATION_MS, script(signs, () => 0, 'Signs'), 'ffmpeg')).toEqual({ kind: 'none', reason: 'no-speech' });
  });

  it('refuses noise', async () => {
    expect(await align(disc, '00000', DURATION_MS, script(unrelatedSpans()), 'ffmpeg')).toEqual({ kind: 'none', reason: 'low-confidence' });
  });

  it('refuses when fewer than three windows decode', async () => {
    const windows = [0, 30_000, 60_000, 90_000, 120_000].map((fromMs) => ({ fromMs, toMs: fromMs + 30_000 }));
    // Clip 00001 holds [0, 90 s): every window but the last two is gone.
    const broken = { ...disc, clip: async (path: string) => (path.endsWith('00001.m2ts') ? null : disc.clip(path)) };
    const ass = script(SPEECH_BURSTS, () => 1230);
    expect(await align(broken, '00000', DURATION_MS, ass, 'ffmpeg', undefined, { windows })).toEqual({ kind: 'none', reason: 'low-confidence' });
    // A short episode's one window must decode.
    expect(await align(broken, '00000', DURATION_MS, ass, 'ffmpeg')).toEqual({ kind: 'none', reason: 'low-confidence' });
  });

  it('rejects when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(align(disc, '00000', DURATION_MS, script(SPEECH_BURSTS), 'ffmpeg', controller.signal)).rejects.toThrow();
  });
});
