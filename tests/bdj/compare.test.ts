import { describe, expect, it } from 'vitest';
import { compareBdjTraces } from './compare';
import { parseBdjTrace } from './format';
import type { TraceEntry } from './format';

const base: TraceEntry[] = [
  { call: 'setKeyInterestN', args: [1], ret: null },
  { call: 'readRegN', args: [4], ret: 65535 },
  { call: 'selectPlaylistN', args: [0, -1, -1, '-1'], ret: 1 },
];

describe('compareBdjTraces', () => {
  it('accepts identical traces', () => {
    expect(() => compareBdjTraces(base, base)).not.toThrow();
  });

  it('names the index, call and both entries of a different argument', () => {
    const ours = [base[0]!, base[1]!, { ...base[2]!, args: [1, -1, -1, '-1'] }];
    expect(() => compareBdjTraces(base, ours)).toThrow(/control call 1 \(selectPlaylistN\)[\s\S]*"args":\[0,-1,-1,"-1"\][\s\S]*"args":\[1,-1,-1,"-1"\]/);
  });

  it('ignores diagnostic calls such as readRegN counts', () => {
    const ours = [base[0]!, base[1]!, base[1]!, base[1]!, base[2]!];
    expect(() => compareBdjTraces(base, ours)).not.toThrow();
  });

  it('fails on a missing control call and ignores extra trailing ones', () => {
    expect(() => compareBdjTraces(base, base.slice(0, 1))).toThrow(/control call 1 \(selectPlaylistN\)[\s\S]*\(missing\)/);
    expect(() => compareBdjTraces(base, [...base, { call: 'seekN', args: [5], ret: 0 }])).not.toThrow();
  });
});

describe('parseBdjTrace', () => {
  it('skips lines that are not JSON objects with a call field', () => {
    const text = '[Loaded java.lang.Object]\n{"call":"seekN","args":[5],"ret":0}\n{"x":1}\n{broken\n\n[1,2]\n';
    expect(parseBdjTrace(text)).toEqual([{ call: 'seekN', args: [5], ret: 0 }]);
  });
});
