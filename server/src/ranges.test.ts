import { describe, expect, it } from 'vitest';
import { parseRange } from './ranges';

describe('parseRange', () => {
  it('reads a closed range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  });

  it('clamps a range ending past EOF', () => {
    expect(parseRange('bytes=900-1999', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('reads an open range and the last partial chunk', () => {
    expect(parseRange('bytes=950-', 1000)).toEqual({ start: 950, end: 999 });
    expect(parseRange('bytes=999-999', 1000)).toEqual({ start: 999, end: 999 });
  });

  it('refuses a range starting at or past EOF', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=1000-1100', 1000)).toBe('unsatisfiable');
  });

  it('reads a suffix range', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });

  it('answers the whole file to multi-range, missing or invalid headers', () => {
    expect(parseRange('bytes=0-0,5-9', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('', 1000)).toBeNull();
    expect(parseRange('items=0-9', 1000)).toBeNull();
    expect(parseRange('bytes=9-3', 1000)).toBeNull();
    expect(parseRange('bytes=a-b', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange('bytes=1.5-3', 1000)).toBeNull();
  });

  it('refuses any range on a zero-length file', () => {
    expect(parseRange('bytes=0-0', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-100', 0)).toBe('unsatisfiable');
  });
});
