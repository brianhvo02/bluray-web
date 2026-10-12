import { describe, expect, it } from 'vitest';
import { TEST_SPS, avcAu } from '../../../tests/helpers/h264-units';
import { analyzeAvc, avcCodecString } from './h264';
import { splitAnnexB } from './nal';

describe('H.264 analysis', () => {
  it('derives the codec string from the SPS', () => {
    expect(avcCodecString(TEST_SPS)).toBe('avc1.640028');
  });

  it('marks IDR access units as key and returns the SPS', () => {
    const info = analyzeAvc(avcAu({ idr: true }));
    expect(info.key).toBe(true);
    expect(info.idr).toBe(true);
    expect(Array.from(info.sps ?? [])).toEqual(Array.from(TEST_SPS));
  });

  it('marks recovery-point I-frames as key but not IDR', () => {
    const info = analyzeAvc(avcAu({ recovery: true, sps: true }));
    expect(info.key).toBe(true);
    expect(info.idr).toBe(false);
  });

  it('marks plain slices as non-key', () => {
    const info = analyzeAvc(avcAu());
    expect(info.key).toBe(false);
    expect(info.sps).toBeNull();
  });

  it('strips MVC NAL units (types 14, 15, 20)', () => {
    const info = analyzeAvc(avcAu({ idr: true, mvc: true }));
    const types = splitAnnexB(info.data).map((n) => n[0] & 0x1f);
    expect(types).toEqual([9, 7, 8, 5]);
  });

  it('returns the original buffer when there is nothing to strip', () => {
    const au = avcAu({ idr: true });
    expect(analyzeAvc(au).data).toBe(au);
  });
});
