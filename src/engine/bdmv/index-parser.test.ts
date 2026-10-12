import { describe, expect, it } from 'vitest';
import { buildIndex } from '../../../tests/helpers/bdmv-builders';
import { ParseError } from '../util/byte-reader';
import { indexUsesBdj, parseIndex } from './index-parser';

describe('parseIndex', () => {
  it('parses HDMV first play, top menu and titles', () => {
    const index = parseIndex(
      buildIndex({
        firstPlay: { kind: 'hdmv', movieObjectId: 0 },
        topMenu: { kind: 'hdmv', movieObjectId: 1 },
        titles: [
          { kind: 'hdmv', movieObjectId: 2 },
          { kind: 'hdmv', movieObjectId: 3, playbackType: 1 },
        ],
      }),
    );
    expect(index.version).toBe('0200');
    expect(index.firstPlay).toEqual({ kind: 'hdmv', playbackType: 0, movieObjectId: 0 });
    expect(index.topMenu).toEqual({ kind: 'hdmv', playbackType: 0, movieObjectId: 1 });
    expect(index.titles.map((t) => t.object)).toEqual([
      { kind: 'hdmv', playbackType: 0, movieObjectId: 2 },
      { kind: 'hdmv', playbackType: 1, movieObjectId: 3 },
    ]);
    expect(indexUsesBdj(index)).toBe(false);
  });

  it('detects BD-J objects', () => {
    const index = parseIndex(
      buildIndex({
        firstPlay: { kind: 'bdj', name: '00000' },
        topMenu: { kind: 'hdmv', movieObjectId: 0 },
        titles: [{ kind: 'bdj', name: '00001' }],
      }),
    );
    expect(index.firstPlay).toEqual({ kind: 'bdj', playbackType: 0, name: '00000' });
    expect(indexUsesBdj(index)).toBe(true);
  });

  it('rejects a bad signature', () => {
    const bytes = buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [] });
    bytes[0] = 0x58;
    expect(() => parseIndex(bytes)).toThrow(ParseError);
  });

  it('rejects a truncated file', () => {
    const bytes = buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'hdmv', movieObjectId: 1 }] });
    expect(() => parseIndex(bytes.subarray(0, bytes.length - 4))).toThrow(ParseError);
  });
});
