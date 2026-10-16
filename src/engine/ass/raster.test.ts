import { describe, expect, it } from 'vitest';
import {
  blurVariance, dilate, FILTER_BORDER_STYLE_3, FILTER_FILL_IN_BORDER, FILTER_FILL_IN_SHADOW, FILTER_NONZERO_BORDER,
  FILTER_NONZERO_SHADOW, fixOutline, gaussianBlur, layerKey, quantizePositions, quantizeShadow, runFlags,
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

describe('gaussianBlur', () => {
  const line = (): Uint8Array => {
    const m = new Uint8Array(40 * 3);
    for (let y = 0; y < 3; y++) m[y * 40 + 19] = m[y * 40 + 20] = 255;
    return m;
  };

  it('softens a 2 px stroke even at deviations under 0.8 px', () => {
    const out = gaussianBlur(line(), 40, 3, 0.64, 0);
    expect(out[40 + 18]).toBeGreaterThan(30);
    expect(out[40 + 19]).toBeGreaterThan(190);
    expect(out[40 + 19]).toBeLessThan(225);
    expect(out[40 + 19]).toBe(out[40 + 20]);
  });

  it('keeps the mass and blurs each axis by its own deviation', () => {
    const out = gaussianBlur(line(), 40, 3, 1.5, 0);
    expect(out.reduce((a, b) => a + b, 0)).toBeGreaterThan(3 * 510 - 12);
    expect(out[18]).toBe(out[40 + 18]); // no vertical blur
    expect(gaussianBlur(line(), 40, 3, 0, 0)).toEqual(line());
  });
});

describe('quantizePositions (quantize_transform)', () => {
  const g = (x0: number, x1: number) => ({ bboxXMin: x0, bboxXMax: x1, bboxYMin: -640, bboxYMax: 0 }) as unknown as Parameters<typeof quantizePositions>[0][number];
  const at = (x: number, y: number) => [1, 0, x, 0, 1, y, 0, 0, 1] as [number, number, number, number, number, number, number, number, number];

  it('moves the run by the rounding of the first inked glyph\'s box centre', () => {
    // centre of glyph 0: (3 + 100, -320 + 5) 26.6 → x 103/8 = 12.875 → 13 (+1), y -315/8 = -39.375 → -39 (+3)
    const [m0, m1] = quantizePositions([g(0, 200), g(0, 202)], [at(3, 5), at(1003, 5)]);
    expect([m0![2], m0![5]]).toEqual([4, 8]);
    // glyph 1: centre x (1003 + 101)/8 = 138 minus the run's offset (-0.125) → 138.125 → 138: unmoved;
    // y has the same centre as glyph 0, so it moves with it
    expect([m1![2], m1![5]]).toEqual([1003, 8]);
  });

  it('ignores glyphs without ink for the run offset and keeps perspective matrices', () => {
    const persp = [1, 0, 3, 0, 1, 5, 1e-3, 0, 1] as const;
    const [space, ink, p] = quantizePositions([g(0, 0), g(0, 200), g(0, 200)], [at(3, 5), at(3, 5), [...persp]]);
    expect(ink![2]).toBe(4); // as if it came first: the space before it sets no offset
    expect(space![2]).toBe(0); // its own centre (3 26.6 = 0.375 grid) rounded
    expect(p).toEqual([...persp]);
  });
});

describe('layerKey', () => {
  it('tells apart runs that differ only in colour, karaoke or shadow offset', () => {
    const base = layerKey('m', [1, 2, 3, 4], 0, 0, 64, 64);
    expect(layerKey('m', [1, 2, 3, 4], 0, 0, 64, 64)).toBe(base);
    expect(layerKey('m', [1, 2, 3, 5], 0, 0, 64, 64)).not.toBe(base);
    expect(layerKey('m', [1, 2, 3, 4], 0, 1, 64, 64)).not.toBe(base);
    expect(layerKey('m', [1, 2, 3, 4], 0, 0, 128, 64)).not.toBe(base); // \xshad changed, same masks
    expect(layerKey('m', [1, 2, 3, 4], 0, 0, 64, -64)).not.toBe(base);
  });
});
