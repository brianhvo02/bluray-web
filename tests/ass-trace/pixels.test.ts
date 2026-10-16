import { describe, expect, it } from 'vitest';
import { comparePixels } from './pixels';

const SIZE = 256;
function grey(square = 0): Uint8Array {
  const img = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) img.set([128, 128, 128, 255], i * 4);
  for (let y = 0; y < square; y++) for (let x = 0; x < square; x++) img.set([255, 255, 255, 255], ((100 + y) * SIZE + 100 + x) * 4);
  return img;
}

describe('comparePixels', () => {
  it('passes identical images', () => {
    expect(comparePixels(grey(), grey(), SIZE, SIZE, [[0, 0, 32, 32]])).toMatchObject({ differing: 0, pass: true });
  });

  it('fails a 10×10 difference against the 64 px floor', () => {
    expect(comparePixels(grey(), grey(10), SIZE, SIZE, [[0, 0, 32, 32]])).toMatchObject({ differing: 100, budget: 64, pass: false });
  });

  it('scales the budget with the event boxes: 0.5% of their area', () => {
    expect(comparePixels(grey(), grey(9), SIZE, SIZE, [[0, 0, 200, 50], [0, 60, 200, 50]])).toMatchObject({ differing: 81, budget: 100, pass: true });
  });

  it('clips boxes to the frame', () => {
    expect(comparePixels(grey(), grey(), SIZE, SIZE, [[-1000, -1000, 100_000, 100_000]]).budget).toBe(Math.round(0.005 * SIZE * SIZE));
  });
});
