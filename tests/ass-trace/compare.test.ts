import { describe, expect, it } from 'vitest';
import { compareTraces } from './compare';
import type { TraceEvent, TraceRun } from './format';

const run: TraceRun = {
  text: 'Hi', font: 'DejaVu Sans|DejaVuSans', size: 64, scale: [1, 1], hspacing: 0, colors: ['FFFFFF00', '0000FF00', '00000000', '00000080'],
  border: [3, 3], shadow: [2, 2], blur: 0, be: 0, rot: [0, 0, 0], shear: [0, 0], borderStyle: 1, flags: 0, bold: 0, italic: 0,
  karaoke: [0, 0], drawing: false, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  glyphs: [{ x: 900, y: 1000, adv: 40, ch: 72 }, { x: 940, y: 1000, adv: 18, ch: 105 }],
};
const ev = (over: Partial<TraceEvent> = {}): TraceEvent => ({ t: 1000, event: 0, layer: 0, box: [890, 940, 80, 80], lines: 1, clip: { rect: [0, 0, 1920, 1080], inverse: false }, runs: [run], ...over });
const glyph0 = (over: Partial<TraceRun['glyphs'][number]>): TraceRun => ({ ...run, glyphs: [{ ...run.glyphs[0]!, ...over }, run.glyphs[1]!] });
const opts = { tolerance: 0.5, missingFamilies: new Set<string>() };

describe('compareTraces', () => {
  it('accepts positions within the tolerance', () => {
    expect(compareTraces([ev()], [ev({ runs: [glyph0({ x: 900.4 })] })], opts)).toEqual([]);
  });

  it('reports a position outside it with its path', () => {
    expect(compareTraces([ev()], [ev({ runs: [glyph0({ x: 901 })] })], opts).map((d) => d.path)).toEqual(['runs[0].glyphs[0].x']);
  });

  it('requires discrete fields to match exactly', () => {
    expect(compareTraces([ev()], [ev({ lines: 2 })], opts).map((d) => d.path)).toEqual(['lines']);
    expect(compareTraces([ev()], [ev({ runs: [{ ...run, colors: ['FFFFFF01', run.colors[1], run.colors[2], run.colors[3]] }] })], opts).map((d) => d.path)).toEqual(['runs[0].colors[0]']);
    expect(compareTraces([ev()], [ev({ clip: { rect: [0, 0, 1920, 1080], inverse: true } })], opts).map((d) => d.path)).toEqual(['clip.inverse']);
  });

  it('reports a different number of runs or glyphs once, not per field', () => {
    expect(compareTraces([ev()], [ev({ runs: [run, run] })], opts).map((d) => d.path)).toEqual(['runs.length']);
    expect(compareTraces([ev()], [ev({ runs: [{ ...run, glyphs: run.glyphs.slice(0, 1) }] })], opts).map((d) => d.path)).toEqual(['runs[0].glyphs.length']);
  });

  it('reports missing and extra events', () => {
    const diffs = compareTraces([ev()], [ev({ event: 1 })], opts);
    expect(diffs.map((d) => [d.event, d.path, d.expected === undefined])).toEqual([[0, '', false], [1, '', true]]);
  });

  it('compares only the requested family of a run drawn in a missing family, and skips its geometry', () => {
    const expected = ev({ runs: [{ ...run, font: 'Fancy|DejaVuSans' }] });
    const actual = ev({ box: [880, 940, 100, 80], runs: [{ ...run, font: 'Fancy|DejaVuSans', glyphs: [{ ...run.glyphs[0]!, x: 950, adv: 50 }, run.glyphs[1]!] }] });
    expect(compareTraces([expected], [actual], { tolerance: 0.5, missingFamilies: new Set(['fancy']) })).toEqual([]);
    expect(compareTraces([expected], [{ ...actual, runs: [{ ...actual.runs[0]!, font: 'Other|DejaVuSans' }] }], { tolerance: 0.5, missingFamilies: new Set(['fancy']) }).map((d) => d.path)).toEqual(['runs[0].font']);
  });

  it('compares matrix translations (26.6) with the position tolerance, the rest relatively', () => {
    const m = (v: number, a = 1) => ev({ runs: [{ ...run, matrix: [a, 0, v, 0, 1, 0, 0, 0, 1] }] });
    expect(compareTraces([m(51576)], [m(51600)], opts)).toEqual([]);
    expect(compareTraces([m(51576)], [m(51700)], opts).map((d) => d.path)).toEqual(['runs[0].matrix[2]']);
    expect(compareTraces([m(0, 1)], [m(0, 1.001)], opts).map((d) => d.path)).toEqual(['runs[0].matrix[0]']);
  });

  it('compares \\k timings (26.6) with the position tolerance and \\kf (px) with the pixel one', () => {
    const k = (type: number, v: number) => ev({ runs: [{ ...run, karaoke: [type, v] }] });
    expect(compareTraces([k(1, -100007792)], [k(1, -100007820)], opts)).toEqual([]);
    expect(compareTraces([k(2, 900)], [k(2, 901)], opts).map((d) => d.path)).toEqual(['runs[0].karaoke[1]']);
  });

  it('compares perspective matrices more loosely than affine ones', () => {
    const m = (a: number, p: number) => ev({ runs: [{ ...run, matrix: [a, 0, 0, 0, 1, 0, p, 0, 1] }] });
    expect(compareTraces([m(3.9108, 1e-4)], [m(3.91129, 1e-4)], opts)).toEqual([]);
    expect(compareTraces([m(3.9108, 0)], [m(3.91129, 0)], opts).map((d) => d.path)).toEqual(['runs[0].matrix[0]']);
  });

  it('allows integer boxes to differ by one pixel (libass truncates them)', () => {
    expect(compareTraces([ev()], [ev({ box: [891, 940, 80, 80] })], opts)).toEqual([]);
    expect(compareTraces([ev()], [ev({ box: [892, 940, 80, 80] })], opts).map((d) => d.path)).toEqual(['box[0]']);
  });
});
