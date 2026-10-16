import { describe, expect, it } from 'vitest';
import { startChoices, startLabel } from './subtitle-starts';

const MIN = 60_000_000;
const chapters = [{ index: 0, startUs: 0 }, { index: 1, startUs: 5 * MIN }, { index: 2, startUs: 24 * MIN }];

describe('startChoices', () => {
  it('lists episodes, chapters, the current position and Not placed', () => {
    expect(startChoices([0, 24 * MIN], chapters, 61_500_000)).toEqual([
      { label: 'Episode 1 · 0:00:00', startUs: 0 },
      { label: 'Episode 2 · 0:24:00', startUs: 24 * MIN },
      { label: 'Chapter 1 · 0:00:00', startUs: 0 },
      { label: 'Chapter 2 · 0:05:00', startUs: 5 * MIN },
      { label: 'Chapter 3 · 0:24:00', startUs: 24 * MIN },
      { label: 'Current position · 0:01:01', startUs: 61_000_000 },
      { label: 'Not placed', startUs: null },
    ]);
  });
});

describe('startLabel', () => {
  it('says Episode for an episode start, Chapter for a chapter, the time otherwise', () => {
    expect(startLabel(24 * MIN, [0, 24 * MIN], chapters)).toBe('0:24:00 · Episode 2');
    expect(startLabel(5 * MIN, [0, 24 * MIN], chapters)).toBe('0:05:00 · Chapter 2');
    expect(startLabel(12 * MIN + 5_000_000, [0], chapters)).toBe('0:12:05');
    expect(startLabel(null, [0], chapters)).toBe('Not placed');
  });
});
