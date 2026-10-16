/** Pixel comparison against libass goldens (budget: plan Global Constraints). */
import pixelmatch from 'pixelmatch';

export interface PixelResult { readonly differing: number; readonly budget: number; readonly pass: boolean; readonly diff: Uint8Array }

const FLOOR = 64;
const SHARE = 0.005;

/** pixelmatch (threshold 0.1, anti-aliasing excluded); budget = max(64, 0.5% of the event boxes' area inside the frame). */
export function comparePixels(expected: Uint8Array, actual: Uint8Array, width: number, height: number, boxes: readonly (readonly [number, number, number, number])[]): PixelResult {
  const diff = new Uint8Array(width * height * 4);
  const differing = pixelmatch(expected, actual, diff, width, height, { threshold: 0.1, includeAA: false });
  let area = 0;
  for (const [x, y, w, h] of boxes) {
    const cw = Math.max(0, Math.min(width, x + w) - Math.max(0, x));
    const ch = Math.max(0, Math.min(height, y + h) - Math.max(0, y));
    area += cw * ch;
  }
  const budget = Math.max(FLOOR, Math.round(SHARE * area));
  return { differing, budget, pass: differing <= budget, diff };
}
