import { describe, expect, it } from 'vitest';
import { formatTime } from './format';

describe('formatTime', () => {
  it('formats minutes and hours', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(8_000_000)).toBe('0:08');
    expect(formatTime(754_900_000)).toBe('12:34');
    expect(formatTime(7_384_000_000)).toBe('2:03:04');
    expect(formatTime(-5)).toBe('0:00');
  });
});
