import { describe, expect, it } from 'vitest';
import { Capacity, LEASE_IDLE_MS, NEED_MARGIN } from './capacity';

const FILM = 24_000 / 1001;
const BUDGETS = { h264: 190, hevc: 100 };

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('Capacity', () => {
  it('needs the film’s fps × 1.3', () => {
    expect(NEED_MARGIN).toBe(1.3);
    const c = new Capacity(BUDGETS, clock().now);
    expect(c.lease('v1', 'h264', FILM)).toBe(true);
    expect(c.inUse().h264Fps).toBeCloseTo(FILM * 1.3, 6);
  });

  it('admits the 4th 1080p H.264 viewing at 23.976 fps (4 × 31 = 124 ≤ 190) and refuses the 7th', () => {
    const c = new Capacity(BUDGETS, clock().now);
    for (let i = 1; i <= 4; i++) expect(c.lease(`v${i}`, 'h264', FILM)).toBe(true);
    expect(c.inUse().h264Fps).toBeCloseTo(124.7, 1);
    expect(c.lease('v5', 'h264', FILM)).toBe(true);
    expect(c.lease('v6', 'h264', FILM)).toBe(true); // 6 × 31.17 = 187 ≤ 190
    expect(c.lease('v7', 'h264', FILM)).toBe(false);
    expect(c.inUse().viewings.map((v) => v.viewingId)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
  });

  it('counts an HEVC viewing against 100 fps', () => {
    const c = new Capacity(BUDGETS, clock().now);
    for (let i = 1; i <= 3; i++) expect(c.lease(`h${i}`, 'hevc', FILM)).toBe(true); // 93.5 ≤ 100
    expect(c.lease('h4', 'hevc', FILM)).toBe(false);
    expect(c.inUse().hevcFps).toBeCloseTo(93.5, 1);
  });

  it('shares one GPU: each viewing takes its share of its own codec’s budget', () => {
    const c = new Capacity(BUDGETS, clock().now);
    // Two HEVC viewings take 62% of the GPU, two H.264 ones 33% more; a third H.264 one (16%) doesn't fit.
    expect(c.lease('h1', 'hevc', FILM)).toBe(true);
    expect(c.lease('h2', 'hevc', FILM)).toBe(true);
    expect(c.lease('a1', 'h264', FILM)).toBe(true);
    expect(c.lease('a2', 'h264', FILM)).toBe(true);
    expect(c.lease('a3', 'h264', FILM)).toBe(false);
    expect(c.fits('h264', FILM)).toBe(false);
    c.release('h2');
    expect(c.fits('h264', FILM)).toBe(true);
  });

  it('a lease held again is kept, not counted twice', () => {
    const c = new Capacity(BUDGETS, clock().now);
    for (let i = 1; i <= 6; i++) c.lease(`v${i}`, 'h264', FILM);
    expect(c.lease('v6', 'h264', FILM)).toBe(true);
    expect(c.inUse().viewings.length).toBe(6);
  });

  it('moves a lease: admitted when the new need fits without the ones it replaces, else the old ones stay', () => {
    const c = new Capacity(BUDGETS, clock().now);
    for (let i = 1; i <= 6; i++) c.lease(`v${i}`, 'h264', FILM);
    expect(c.lease('v6-hevc', 'hevc', FILM, ['v6'])).toBe(false);
    expect(c.inUse().viewings.map((v) => v.viewingId)).toContain('v6');
    expect(c.lease('v6-other', 'h264', FILM, ['v6'])).toBe(true);
    expect(c.inUse().viewings.map((v) => v.viewingId)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6-other']);
  });

  it('a lease expires 2 min after the last touch', () => {
    expect(LEASE_IDLE_MS).toBe(120_000);
    const t = clock();
    const c = new Capacity(BUDGETS, t.now);
    for (let i = 1; i <= 6; i++) c.lease(`v${i}`, 'h264', FILM);
    t.advance(100_000);
    c.touch('v1');
    t.advance(20_000); // v2…v6 are 2 min past their lease; v1 was touched 20 s ago
    expect(c.inUse().viewings.map((v) => v.viewingId)).toEqual(['v1']);
    expect(c.has('v2')).toBe(false);
    t.advance(99_999);
    expect(c.has('v1')).toBe(true);
    t.advance(1);
    expect(c.has('v1')).toBe(false);
    expect(c.inUse().h264Fps).toBe(0);
  });

  it('release frees the capacity at once', () => {
    const c = new Capacity(BUDGETS, clock().now);
    for (let i = 1; i <= 6; i++) c.lease(`v${i}`, 'h264', FILM);
    expect(c.lease('v7', 'h264', FILM)).toBe(false);
    c.release('v3');
    expect(c.lease('v7', 'h264', FILM)).toBe(true);
  });
});
