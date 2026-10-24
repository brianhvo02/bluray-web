import { describe, expect, it } from 'vitest';
import type { ToshoSearchResult } from '../../engine/disc/nas-api';
import { defaultQuery, fileLabel, releaseDate, releaseLabel, sortTracks, trackLabel } from './tosho-search-model';

const release = (seadex: ToshoSearchResult['seadex']): ToshoSearchResult => ({ id: 1, title: '[GroupA] Starfall Wanderer (BD 1080p)', date: 1_700_000_000, seadex });

describe('tosho search model', () => {
  it('badges a release by its SeaDex rank', () => {
    expect(releaseLabel(release('best'))).toEqual({ text: '[GroupA] Starfall Wanderer (BD 1080p)', badge: 'SeaDex best' });
    expect(releaseLabel(release('web')).badge).toBe('SeaDex');
    expect(releaseLabel(release('other')).badge).toBe('SeaDex');
    expect(releaseLabel(release(null)).badge).toBeNull();
  });

  it('dates a release by its day', () => {
    expect(releaseDate(release(null))).toBe('2023-11-14');
  });

  it('puts English tracks first, then by language name, then by track', () => {
    const tracks = [
      { track: 3, language: 'spa', name: 'Completo' },
      { track: 2, language: 'eng', name: 'Signs' },
      { track: 4, language: 'fre', name: 'Complet' },
      { track: 0, language: 'eng', name: 'Full' },
      { track: 1, language: 'en', name: 'Honorifics' },
    ];
    expect(sortTracks(tracks).map((t) => t.track)).toEqual([0, 1, 2, 4, 3]);
    expect(tracks[0]!.track).toBe(3); // a copy, not sorted in place
  });

  it('labels tracks and files', () => {
    expect(trackLabel({ track: 0, language: 'eng', name: 'Full' })).toBe('English · Full');
    expect(trackLabel({ track: 0, language: 'eng', name: '' })).toBe('English');
    expect(trackLabel({ track: 0, language: '', name: 'Full' })).toBe('Full');
    expect(fileLabel({ id: 1, name: 'a.mkv', episode: 5, tracks: [] })).toBe('Episode 5');
    expect(fileLabel({ id: 1, name: 'a.mkv', episode: null, tracks: [] })).toBe('a.mkv');
  });

  it("searches by the title's name, else the disc's name without its tags", () => {
    expect(defaultQuery('Starfall Wanderer', '[250226] SW_DISC1')).toBe('Starfall Wanderer');
    expect(defaultQuery(null, '[250226] Starfall_Wanderer (Disc 1)')).toBe('Starfall Wanderer');
    expect(defaultQuery('  ', 'Starfall Wanderer')).toBe('Starfall Wanderer');
    expect(defaultQuery(null, '[only tags]')).toBe('[only tags]');
  });
});
