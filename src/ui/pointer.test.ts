import { describe, expect, it } from 'vitest';
import { toMenuSpace } from './pointer';

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height }) as DOMRect;

describe('toMenuSpace', () => {
  it('maps the centre of the canvas to the centre of the 1920x1080 menu', () => {
    expect(toMenuSpace(500, 500, rect(0, 0, 1000, 1000))).toEqual({ x: 960, y: 540 });
  });

  it('accounts for the canvas position and the letterbox', () => {
    // 1000x1000 shows the picture as 1000x563 starting at y = 218
    expect(toMenuSpace(100 + 0, 50 + 218, rect(100, 50, 1000, 1000))).toEqual({ x: 0, y: 0 });
    expect(toMenuSpace(1099, 50 + 218 + 562, rect(100, 50, 1000, 1000))).toEqual({ x: 1918, y: 1078 });
  });

  it('maps a tap through the rectangle the canvas has now, after a rotation (Review Focus 1)', () => {
    const near = (p: { x: number; y: number } | null, x: number, y: number): void => {
      expect(p).not.toBeNull();
      expect(Math.abs(p!.x - x)).toBeLessThanOrEqual(4);
      expect(Math.abs(p!.y - y)).toBeLessThanOrEqual(4);
    };
    // portrait phone: 390x844 canvas, the picture letterboxed to 390x219 at y ≈ 312
    const portrait = rect(0, 0, 390, 844);
    // the same phone rotated: 844x390, the picture pillarboxed to 693x390 at x ≈ 75
    const landscape = rect(0, 0, 844, 390);
    near(toMenuSpace(195, 422, portrait), 960, 540);
    near(toMenuSpace(422, 195, landscape), 960, 540);
    // the point that was the menu's centre in portrait lies outside the picture once rotated
    expect(toMenuSpace(195, 422, landscape)).toBeNull();
    // a quarter of the way into the picture, in each orientation
    near(toMenuSpace(97.5, 312.5 + 54.8, portrait), 480, 270);
    near(toMenuSpace(75.5 + 173.25, 97.5, landscape), 480, 270);
  });

  it('is null outside the picture', () => {
    expect(toMenuSpace(500, 100, rect(0, 0, 1000, 1000))).toBeNull();
    expect(toMenuSpace(500, 900, rect(0, 0, 1000, 1000))).toBeNull();
  });
});
