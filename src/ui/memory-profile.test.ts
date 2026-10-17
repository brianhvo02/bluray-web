import { describe, expect, it } from 'vitest';
import { chooseMemoryProfile } from './memory-profile';

describe('chooseMemoryProfile', () => {
  it('chooses constrained for an iPhone (coarse pointer)', () => {
    expect(chooseMemoryProfile({ search: '', coarsePointer: true, maxTouchPoints: 5, platform: 'iPhone' })).toBe('constrained');
  });
  it('chooses constrained for an iPad with a trackpad (reports MacIntel, fine pointer)', () => {
    expect(chooseMemoryProfile({ search: '', coarsePointer: false, maxTouchPoints: 5, platform: 'MacIntel' })).toBe('constrained');
  });
  it('chooses desktop for a Mac', () => {
    expect(chooseMemoryProfile({ search: '', coarsePointer: false, maxTouchPoints: 0, platform: 'MacIntel' })).toBe('desktop');
  });
  it('lets ?memory= override the detection', () => {
    expect(chooseMemoryProfile({ search: '?memory=desktop', coarsePointer: true, maxTouchPoints: 5, platform: 'iPhone' })).toBe('desktop');
    expect(chooseMemoryProfile({ search: '?memory=constrained', coarsePointer: false, maxTouchPoints: 0, platform: 'Win32' })).toBe('constrained');
  });
});
