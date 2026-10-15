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

  it('is null outside the picture', () => {
    expect(toMenuSpace(500, 100, rect(0, 0, 1000, 1000))).toBeNull();
    expect(toMenuSpace(500, 900, rect(0, 0, 1000, 1000))).toBeNull();
  });
});
