import { describe, expect, it } from 'vitest';
import { DiscError } from './byte-source';
import { FileSource } from './file-source';

function source(): FileSource {
  return new FileSource(
    new Map<string, Blob>([
      ['BDMV/INDEX.BDMV', new Blob([new Uint8Array([1, 2, 3, 4, 5])])],
      ['BDMV/PLAYLIST/00000.MPLS', new Blob(['a'])],
      ['BDMV/PLAYLIST/00001.MPLS', new Blob(['b'])],
      ['BDMV/PLAYLIST/SUB/IGNORED.MPLS', new Blob(['c'])],
    ]),
  );
}

describe('FileSource', () => {
  it('answers exists/size/list case-insensitively', () => {
    const s = source();
    expect(s.exists('bdmv/index.bdmv')).toBe(true);
    expect(s.exists('BDMV/MovieObject.bdmv')).toBe(false);
    expect(s.size('BDMV/INDEX.BDMV')).toBe(5);
    expect(s.list('BDMV/PLAYLIST')).toEqual(['00000.MPLS', '00001.MPLS']);
    expect(s.list('AACS')).toEqual([]);
  });

  it('reads byte ranges and clamps at end of file', async () => {
    const s = source();
    expect(Array.from(await s.read('BDMV/INDEX.BDMV', 1, 2))).toEqual([2, 3]);
    expect(Array.from(await s.read('BDMV/INDEX.BDMV', 3, 100))).toEqual([4, 5]);
    expect((await s.read('BDMV/INDEX.BDMV', 9, 4)).length).toBe(0);
  });

  it('throws missing-file for unknown paths', async () => {
    await expect(source().read('BDMV/STREAM/00000.M2TS', 0, 1)).rejects.toMatchObject({ code: 'missing-file' });
    expect(() => source().size('BDMV/STREAM/00000.M2TS')).toThrow(DiscError);
  });

  it('maps NotReadableError to source-changed and other failures to read-failed', async () => {
    const failing = (err: unknown): Blob =>
      ({ size: 10, slice: () => ({ arrayBuffer: () => Promise.reject(err) }) }) as unknown as Blob;
    const changed = new FileSource(new Map([['A', failing(new DOMException('gone', 'NotReadableError'))]]));
    await expect(changed.read('A', 0, 4)).rejects.toMatchObject({ code: 'source-changed' });
    const broken = new FileSource(new Map([['A', failing(new Error('boom'))]]));
    await expect(broken.read('A', 0, 4)).rejects.toMatchObject({ code: 'read-failed' });
  });
});
