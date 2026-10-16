import { describe, expect, it } from 'vitest';
import { BUILT_IN_SETS, missingLabel, parseInputConf, resolveSets } from './shader-sets';

const HQ_A = [
  'Anime4K_Clamp_Highlights.glsl',
  'Anime4K_Restore_CNN_VL.glsl',
  'Anime4K_Upscale_CNN_x2_VL.glsl',
  'Anime4K_AutoDownscalePre_x2.glsl',
  'Anime4K_AutoDownscalePre_x4.glsl',
  'Anime4K_Upscale_CNN_x2_M.glsl',
];

describe('BUILT_IN_SETS', () => {
  it('has 12 entries in template order', () => {
    expect(BUILT_IN_SETS).toHaveLength(12);
    expect(BUILT_IN_SETS[0]).toEqual({ name: 'Anime4K: Mode A (HQ)', files: HQ_A, origin: 'anime4k' });
    expect(BUILT_IN_SETS[6]!.name).toBe('Anime4K: Mode A (Fast)');
    expect(BUILT_IN_SETS[6]!.files.at(-1)).toBe('Anime4K_Upscale_CNN_x2_S.glsl');
  });
});

describe('parseInputConf', () => {
  it('reads the Windows template the same as the Mac/Linux one', () => {
    const win =
      '# Optimized shaders for higher-end GPU:\r\n' +
      'CTRL+1 no-osd change-list glsl-shaders set "~~/shaders/' +
      HQ_A.join(';~~/shaders/') +
      '"; show-text "Anime4K: Mode A (HQ)"\r\n\r\n' +
      'CTRL+0 no-osd change-list glsl-shaders clr ""; show-text "GLSL shaders cleared"';
    expect(parseInputConf(win)).toEqual([{ name: 'Anime4K: Mode A (HQ)', files: HQ_A, origin: 'imported' }]);
  });
  it('ignores clr lines and comments', () => {
    expect(parseInputConf('# c\nCTRL+0 no-osd change-list glsl-shaders clr ""; show-text "x"')).toEqual([]);
  });
  it('names a set by its key without show-text', () => {
    expect(parseInputConf('F1 change-list glsl-shaders set "a.glsl:b.glsl"')).toEqual([
      { name: 'F1', files: ['a.glsl', 'b.glsl'], origin: 'imported' },
    ]);
  });
  it('accepts set without change-list', () => {
    expect(parseInputConf('F2 glsl-shaders set "~~/shaders/x.glsl"')[0]!.files).toEqual(['x.glsl']);
  });
});

describe('resolveSets', () => {
  it('shows no built-ins for an empty library', () => {
    expect(resolveSets([], new Set())).toEqual([]);
  });
  it('shows all built-ins, unavailable, once one file is present', () => {
    const r = resolveSets([], new Set(['Anime4K_Clamp_Highlights.glsl']));
    expect(r).toHaveLength(12);
    expect(r[0]!.available).toBe(false);
    expect(r[0]!.missing[0]).toBe('Anime4K_Restore_CNN_VL.glsl');
  });
  it('marks a fully present set available', () => {
    const r = resolveSets([], new Set(BUILT_IN_SETS[6]!.files));
    expect(r[6]!.available).toBe(true);
    expect(r[6]!.missing).toEqual([]);
  });
  it('drops imported sets equal to a built-in and keeps the rest after', () => {
    const other = { name: 'mine', files: ['m.glsl'], origin: 'imported' as const };
    const r = resolveSets([{ name: 'dup', files: HQ_A, origin: 'imported' }, other], new Set(HQ_A));
    expect(r.some((e) => e.name === 'dup')).toBe(false);
    expect(r.at(-1)).toMatchObject({ name: 'mine', available: false, missing: ['m.glsl'] });
  });
});

describe('missingLabel', () => {
  it('formats', () => {
    expect(missingLabel(['a'])).toBe('missing: a');
    expect(missingLabel(['a', 'b', 'c'])).toBe('missing: a +2 more');
  });
});
