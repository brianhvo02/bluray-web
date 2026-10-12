import { describe, expect, it } from 'vitest';
import { buildClpi } from '../../../tests/helpers/bdmv-builders';
import { ParseError } from '../util/byte-reader';
import { findEpAfter, findEpBefore, parseClpi } from './clpi-parser';
import { CodingType } from './stream-types';

const BASE = 450_048; // multiple of 256

function clipWith(entries: Array<{ pts: number; spn: number }>): Uint8Array {
  return buildClpi({
    numSourcePackets: 500_000,
    streams: [
      { pid: 0x1011, codingType: CodingType.AVC },
      { pid: 0x1100, codingType: CodingType.LPCM },
    ],
    presentationStart: BASE,
    presentationEnd: BASE + 450_000,
    epMaps: [{ pid: 0x1011, entries }],
  });
}

describe('parseClpi', () => {
  it('parses clip info, sequences and program streams', () => {
    const clpi = parseClpi(clipWith([{ pts: BASE, spn: 0 }]));
    expect(clpi.version).toBe('0200');
    expect(clpi.numSourcePackets).toBe(500_000);
    expect(clpi.atcSequences[0].stc[0]).toEqual({ pcrPid: 0x1001, spnStcStart: 0, presentationStart: BASE, presentationEnd: BASE + 450_000 });
    expect(clpi.programs[0].streams.map((s) => [s.pid, s.codingType, s.lang])).toEqual([
      [0x1011, CodingType.AVC, ''],
      [0x1100, CodingType.LPCM, 'eng'],
    ]);
  });

  it('reconstructs EP entries from coarse/fine tables, including SPN carries past 0x20000', () => {
    const entries = [
      { pts: BASE, spn: 0 },
      { pts: BASE + 22_528, spn: 0x1fff0 },
      { pts: BASE + 45_056, spn: 0x20010 }, // crosses a 17-bit SPN boundary → new coarse entry
      { pts: BASE + 600_064, spn: 0x50000 }, // crosses a PTS coarse boundary
    ];
    const clpi = parseClpi(clipWith(entries));
    expect(clpi.epMaps).toHaveLength(1);
    expect(clpi.epMaps[0].pid).toBe(0x1011);
    expect(clpi.epMaps[0].entries).toEqual(entries);
  });

  it('truncates the low 8 bits of EP pts like real discs', () => {
    const clpi = parseClpi(clipWith([{ pts: BASE + 1000, spn: 5 }]));
    expect(clpi.epMaps[0].entries[0]).toEqual({ pts: BASE + 768, spn: 5 });
  });

  it('rejects a bad signature', () => {
    const bytes = clipWith([]);
    bytes[0] = 0x00;
    expect(() => parseClpi(bytes)).toThrow(ParseError);
  });
});

describe('EP lookup', () => {
  const map = { pid: 0x1011, epStreamType: 1, entries: [{ pts: 1000, spn: 10 }, { pts: 2000, spn: 20 }, { pts: 3000, spn: 30 }] };

  it('findEpBefore returns the last entry at or before the target', () => {
    expect(findEpBefore(map, 2000)).toEqual({ pts: 2000, spn: 20 });
    expect(findEpBefore(map, 2999)).toEqual({ pts: 2000, spn: 20 });
    expect(findEpBefore(map, 99_999)).toEqual({ pts: 3000, spn: 30 });
  });

  it('findEpBefore falls back to the first entry when the target precedes all entries', () => {
    expect(findEpBefore(map, 5)).toEqual({ pts: 1000, spn: 10 });
    expect(findEpBefore({ ...map, entries: [] }, 5)).toBeUndefined();
  });

  it('findEpAfter returns the first entry strictly after the target', () => {
    expect(findEpAfter(map, 2000)).toEqual({ pts: 3000, spn: 30 });
    expect(findEpAfter(map, 0)).toEqual({ pts: 1000, spn: 10 });
    expect(findEpAfter(map, 3000)).toBeUndefined();
  });
});
