import { describe, expect, it } from 'vitest';
import type { DiscEvidence } from '../titles/evidence';
import { libraryFansubDiscs } from './disc-lookup';

const FP = 'A'.repeat(32);
const ev = (discId: string, fingerprint: string | null, durationS = 1500): DiscEvidence =>
  ({ discId, fingerprint, playlists: [{ id: '00001', durationS, chapters: 1, clips: ['00001'] }] }) as unknown as DiscEvidence;

describe('libraryFansubDiscs', () => {
  it('resolves keys, copies and lengths, and follows the library after a rescan', () => {
    let list: readonly DiscEvidence[] = [ev('0000000000000001', FP), ev('0000000000000002', FP), ev('0000000000000003', null, 60)];
    const lookup = libraryFansubDiscs({ evidence: () => list });
    expect(lookup.discKey('0000000000000001')).toBe(`f.${FP}`);
    expect(lookup.discKey('0000000000000003')).toBe('d.0000000000000003');
    expect(lookup.discKey('00000000000000ff')).toBeNull();
    expect(lookup.discIds(`f.${FP}`)).toEqual(['0000000000000001', '0000000000000002']);
    expect(lookup.discIds('d.0000000000000003')).toEqual(['0000000000000003']);
    expect(lookup.discIds('bad')).toEqual([]);
    expect(lookup.durationMs('0000000000000003', '00001')).toBe(60_000);
    expect(lookup.durationMs('0000000000000003', '00002')).toBeNull();

    // a rescan: a copy moved away, another disc came
    list = [ev('0000000000000002', FP), ev('0000000000000004', null)];
    expect(lookup.discIds(`f.${FP}`)).toEqual(['0000000000000002']);
    expect(lookup.discKey('0000000000000001')).toBeNull();
    expect(lookup.discKey('0000000000000004')).toBe('d.0000000000000004');
  });
});
