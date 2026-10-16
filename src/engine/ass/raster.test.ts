import { describe, expect, it } from 'vitest';
import {
  blurVariance, dilate, FILTER_BORDER_STYLE_3, FILTER_FILL_IN_BORDER, FILTER_FILL_IN_SHADOW, FILTER_NONZERO_BORDER,
  FILTER_NONZERO_SHADOW, fixOutline, quantizeShadow, runFlags,
} from './raster';

const glyph = (over: Record<string, number | number[]> = {}) => ({
  borderStyle: 1, borderX: 2, borderY: 2, shadowX: 0, shadowY: 0, effectType: 0, fade: 0, c: [0xffffff00, 0x0000ff00, 0, 0x80], ...over,
}) as unknown as Parameters<typeof runFlags>[0];

describe('runFlags (render_and_combine_glyphs)', () => {
  it('fills the border under an opaque fill with no fade', () => {
    expect(runFlags(glyph())).toBe(FILTER_NONZERO_BORDER | FILTER_FILL_IN_BORDER);
  });
  it('keeps a shadow only with a border or a fill-in shadow', () => {
    expect(runFlags(glyph({ shadowX: 2, shadowY: 2 }))).toBe(FILTER_NONZERO_BORDER | FILTER_NONZERO_SHADOW | FILTER_FILL_IN_SHADOW | FILTER_FILL_IN_BORDER);
    expect(runFlags(glyph({ borderX: 0, borderY: 0, shadowX: 2, c: [0xffffffff, 0, 0, 0] }))).toBe(0);
  });
  it('treats an opaque box style as filled border', () => {
    expect(runFlags(glyph({ borderStyle: 3 })) & (FILTER_BORDER_STYLE_3 | FILTER_FILL_IN_BORDER)).toBe(FILTER_BORDER_STYLE_3 | FILTER_FILL_IN_BORDER);
  });
  it('does not fill the border under a semi-transparent fill', () => {
    expect(runFlags(glyph({ c: [0xffffff80, 0x0000ff00, 0, 0] })) & FILTER_FILL_IN_BORDER).toBe(0);
  });
});

describe('blurVariance', () => {
  it('is zero without blur and grows with \\blur through libass quantisation', () => {
    expect(blurVariance(0, 1)).toBe(0);
    const v2 = blurVariance(2, 1);
    // radius 2 × 2/sqrt(ln 256) ≈ 1.699 px, quantised to step 13, restored to σ = expm1(13/256)·32 ≈ 1.667
    expect(Math.sqrt(v2)).toBeCloseTo(32 * Math.expm1(13 / 256), 9);
    expect(blurVariance(4, 1)).toBeGreaterThan(v2);
  });
});

describe('quantizeShadow', () => {
  it('rounds the 26.6 shadow offset to the blur-dependent grid', () => {
    expect(quantizeShadow(2 * 64, 0)).toBe(128);
    expect(quantizeShadow(130, 0)).toBe(128);
  });
});

describe('fixOutline', () => {
  it('cuts the fill out of the border as ass_fix_outline does', () => {
    const fill = new Uint8Array([0, 128, 255, 200]);
    const border = new Uint8Array([255, 255, 255, 100]);
    fixOutline(fill, border);
    expect([...border]).toEqual([255, 191, 0, 0]);
  });
});

describe('dilate', () => {
  it('grows a single pixel into a disk of the radius', () => {
    const w = 9;
    const m = new Uint8Array(w * w);
    m[4 * w + 4] = 255;
    const out = dilate(m, w, w, 2, 2);
    expect(out[4 * w + 4]).toBe(255);
    expect(out[4 * w + 5]).toBe(255);
    expect(out[4 * w + 6]).toBe(255);
    expect(out[4 * w + 8]).toBe(0);
    expect(out[2 * w + 4]).toBe(255);
    expect(out[2 * w + 2]).toBeLessThan(255); // √8 ≈ 2.83 > 2: partly covered
  });

  it('dilates by an ellipse with different radii', () => {
    const w = 11;
    const m = new Uint8Array(w * w);
    m[5 * w + 5] = 255;
    const out = dilate(m, w, w, 4, 1);
    expect(out[5 * w + 9]).toBe(255);
    expect(out[8 * w + 5]).toBe(0);
  });
});
