import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './png';

describe('png', () => {
  it('round-trips RGBA exactly', () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 0xff);
    const out = decodePng(encodePng(3, 2, rgba));
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect([...out.rgba]).toEqual([...rgba]);
  });

  it('rejects anything that is not 8-bit RGBA', () => {
    const png = encodePng(1, 1, new Uint8Array(4));
    png[25] = 2; // colour type RGB
    expect(() => decodePng(png)).toThrow(/RGBA/);
  });
});
