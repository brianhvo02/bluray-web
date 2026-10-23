import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEECH_BURSTS } from '../../../tests/helpers/speech-bursts';
import { folderDiscSource } from '../levels/level-discs';
import { episodeAudio, windowsFor, type AudioWindow } from './disc-audio';

const hasAc3 = spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' }).stdout?.includes(' ac3 ') ?? false;
/** CI installs ffmpeg: there, a missing AC-3 decoder fails these tests instead of skipping them. */
const runFfmpegTests = hasAc3 || Boolean(process.env.CI);

const disc = folderDiscSource(join(import.meta.dirname, '../../../fixtures/synthetic/disc-speech'), { id: 'speech', name: 'Speech' });

/** The share of the window's 10 ms frames that are loud (RMS above -35 dBFS) exactly where a burst is, give or take 20 ms. */
function agreement(w: AudioWindow): { frames: number; share: number } {
  const frame = 160;
  let agree = 0;
  const frames = Math.floor(w.pcm.length / frame);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let j = 0; j < frame; j++) sum += (w.pcm[i * frame + j] / 32768) ** 2;
    const loud = 20 * Math.log10(Math.sqrt(sum / frame) + 1e-9) > -35;
    const from = w.startMs + i * 10;
    const inBurst = SPEECH_BURSTS.some((b) => from >= b.fromMs - 20 && from + 10 <= b.toMs + 20);
    const nearEdge = SPEECH_BURSTS.some((b) => Math.abs(from - b.fromMs) < 20 || Math.abs(from + 10 - b.toMs) < 20);
    if (loud === inBurst || nearEdge) agree++;
  }
  return { frames, share: agree / frames };
}

/** The shift of the window's start (a multiple of 10 ms, within 100 ms) at which its loud frames agree best with the bursts. */
function bestShiftMs(w: AudioWindow): number {
  let best = 0;
  let bestAgree = -1;
  for (let shift = -100; shift <= 100; shift += 10) {
    let agree = 0;
    for (let i = 0; i < Math.floor(w.pcm.length / 160); i++) {
      let sum = 0;
      for (let j = 0; j < 160; j++) sum += (w.pcm[i * 160 + j] / 32768) ** 2;
      const loud = 10 * Math.log10(sum / 160 + 1e-12) > -35;
      const from = w.startMs + shift + i * 10;
      if (loud === SPEECH_BURSTS.some((b) => from >= b.fromMs && from + 10 <= b.toMs)) agree++;
    }
    if (agree > bestAgree) {
      bestAgree = agree;
      best = shift;
    }
  }
  return best;
}

describe.skipIf(!runFfmpegTests)('episodeAudio', () => {
  it("a window's loud samples sit on the bursts", async () => {
    const [w] = await episodeAudio(disc, '00000', [{ fromMs: 20_000, toMs: 50_000 }], 'ffmpeg');
    expect(w.startMs).toBe(20_000);
    expect(w.pcm.length).toBe(30_000 * 16);
    const { frames, share } = agreement(w);
    expect(frames).toBe(3000);
    expect(share).toBeGreaterThanOrEqual(0.95);
  });

  it('a window across the clip boundary', async () => {
    const [w] = await episodeAudio(disc, '00000', [{ fromMs: 85_000, toMs: 100_000 }], 'ffmpeg');
    expect(w.pcm.length).toBe(15_000 * 16);
    expect(agreement(w).share).toBeGreaterThanOrEqual(0.95);
  });

  it('places samples within 20 ms of their playlist time, in both clips', async () => {
    for (const window of [{ fromMs: 20_000, toMs: 50_000 }, { fromMs: 90_000, toMs: 140_000 }]) {
      const [w] = await episodeAudio(disc, '00000', [window], 'ffmpeg');
      expect(Math.abs(bestShiftMs(w))).toBeLessThanOrEqual(20);
    }
  });

  it('the whole episode', async () => {
    const [w] = await episodeAudio(disc, '00000', 'whole', 'ffmpeg');
    expect(w.startMs).toBe(0);
    expect(w.pcm.length).toBe(150_000 * 16);
    expect(agreement(w).share).toBeGreaterThanOrEqual(0.95);
  });
});

describe('windowsFor', () => {
  it('takes the whole of an episode under three minutes', () => {
    expect(windowsFor(150_000)).toEqual([{ fromMs: 0, toMs: 150_000 }]);
  });

  it('spreads six minutes-long windows over a full episode', () => {
    const ws = windowsFor(1_440_000);
    expect(ws).toHaveLength(6);
    for (const w of ws) expect(w.toMs - w.fromMs).toBe(60_000);
    expect(ws[0].fromMs).toBe(90_000);
    expect(ws[5].toMs).toBe(1_350_000);
  });

  it('takes fewer and shorter windows of a short episode', () => {
    const ws = windowsFor(300_000);
    expect(ws.length).toBeLessThan(6);
    expect(ws[0].fromMs).toBe(90_000);
    expect(ws[ws.length - 1].toMs).toBeLessThanOrEqual(210_000);
    for (const w of ws) expect(w.toMs - w.fromMs).toBeLessThanOrEqual(60_000);
  });
});
