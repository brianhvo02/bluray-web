import { describe, expect, it } from 'vitest';
import { DiscError } from './byte-source';
import { normalizeDiscPaths } from './paths';

const blob = new Blob(['x']);
const keys = (paths: string[]): string[] => [...normalizeDiscPaths(paths.map((p) => [p, blob] as const)).keys()].sort();

describe('normalizeDiscPaths', () => {
  it('accepts the disc root folder and keeps siblings of BDMV', () => {
    expect(keys(['MyMovie/BDMV/index.bdmv', 'MyMovie/BDMV/PLAYLIST/00000.mpls', 'MyMovie/AACS/Unit_Key_RO.inf'])).toEqual([
      'AACS/UNIT_KEY_RO.INF',
      'BDMV/INDEX.BDMV',
      'BDMV/PLAYLIST/00000.MPLS',
    ]);
  });

  it('accepts the BDMV folder itself', () => {
    expect(keys(['BDMV/index.bdmv', 'BDMV/STREAM/00000.m2ts'])).toEqual(['BDMV/INDEX.BDMV', 'BDMV/STREAM/00000.M2TS']);
  });

  it('accepts a parent folder containing exactly one disc and ignores unrelated files', () => {
    expect(keys(['Discs/MyMovie/BDMV/index.bdmv', 'Discs/notes.txt'])).toEqual(['BDMV/INDEX.BDMV']);
  });

  it('accepts a lower-case bdmv folder', () => {
    expect(keys(['disc/bdmv/index.bdmv'])).toEqual(['BDMV/INDEX.BDMV']);
  });

  it('rejects a folder containing two discs', () => {
    try {
      keys(['Discs/A/BDMV/index.bdmv', 'Discs/B/BDMV/index.bdmv']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DiscError);
      expect((err as DiscError).code).toBe('multiple-discs');
      expect((err as DiscError).paths).toEqual(['Discs/A', 'Discs/B']);
    }
  });

  it('rejects a selection without a BDMV folder', () => {
    expect(() => keys(['Photos/a.jpg'])).toThrow(DiscError);
  });
});
