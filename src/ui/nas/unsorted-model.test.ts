import { describe, expect, it } from 'vitest';
import type { TitleSummary, UnsortedReason } from '../../engine/disc/nas-api';
import { NasHttpError } from './nas-client';
import {
  REASON_TEXT,
  blurayComSearchUrl,
  discPlace,
  lookupFailure,
  mergeResults,
  parseNumber,
  reasonText,
  skippedText,
  suggestionLine,
  titleChoice,
} from './unsorted-model';

const REASONS: readonly UnsortedReason[] = ['no-title', 'several-fit', 'no-season', 'episode-past-season', 'no-disc-number', 'sources-disagree', 'source-unreachable'];

const summary = (over: Partial<TitleSummary> & { id: string }): TitleSummary => ({
  kind: 'series',
  names: { english: 'Ember Tide', romaji: null, native: null, synonyms: [], display: null },
  poster: null,
  year: null,
  seasons: 1,
  discs: 0,
  addedAt: 0,
  own: false,
  ...over,
});

describe('reasonText', () => {
  it('gives every reason its text', () => {
    expect(REASONS.map(reasonText)).toEqual([
      'No title found',
      'More than one title fits',
      'No season number',
      "Episode number is past the season's last",
      'No disc number',
      'The sources disagree',
      "AniList or TMDB couldn't be reached; it will try again",
    ]);
    expect(Object.keys(REASON_TEXT).sort()).toEqual([...REASONS].sort());
  });
});

describe('blurayComSearchUrl', () => {
  it("searches Blu-ray.com's movies for the catalogue number, encoded", () => {
    expect(blurayComSearchUrl('BCXA-1234')).toBe('https://www.blu-ray.com/search/?quicksearch=1&quicksearch_keyword=BCXA-1234&section=bluraymovies');
    expect(blurayComSearchUrl('ANZX 1&2/3')).toBe('https://www.blu-ray.com/search/?quicksearch=1&quicksearch_keyword=ANZX%201%262%2F3&section=bluraymovies');
  });
});

describe('discPlace', () => {
  it("splits a disc's path into its folder name and where it is", () => {
    expect(discPlace('drv5/Ember Tide/Ember Tide Vol.1')).toEqual({ name: 'Ember Tide Vol.1', parent: 'drv5/Ember Tide' });
    expect(discPlace('disc1')).toEqual({ name: 'disc1', parent: '' });
  });
});

describe('suggestionLine', () => {
  it('reads native name · year · source', () => {
    expect(suggestionLine(summary({ id: 'anilist:1', names: { english: 'Ember Tide', romaji: null, native: '燃える潮', synonyms: [], display: null }, year: 2016 }))).toBe('燃える潮 · 2016 · AniList');
    expect(suggestionLine(summary({ id: 'tmdb-movie:7', kind: 'movie' }))).toBe('Movie · TMDB');
    expect(suggestionLine(summary({ id: 'own:0', kind: 'music', own: true }))).toBe('Music · Own title');
  });
});

describe('parseNumber', () => {
  it('reads a blank field as no number, and refuses anything but 1 to 1000', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber(' 3 ')).toBe(3);
    expect(parseNumber('３')).toBe(3);
    expect(parseNumber('0')).toBeUndefined();
    expect(parseNumber('1001')).toBeUndefined();
    expect(parseNumber('2.5')).toBeUndefined();
    expect(parseNumber('two')).toBeUndefined();
  });
});

describe('titleChoice', () => {
  it('keeps the season for a series only', () => {
    expect(titleChoice(summary({ id: 'anilist:1' }), 2, 3)).toEqual({ kind: 'title', titleId: 'anilist:1', season: 2, disc: 3 });
    expect(titleChoice(summary({ id: 'tmdb-movie:7', kind: 'movie' }), 2, null)).toEqual({ kind: 'title', titleId: 'tmdb-movie:7', season: null, disc: null });
  });
});

describe('mergeResults', () => {
  it('keeps the first of each title, in order', () => {
    const a = summary({ id: 'anilist:1' });
    const b = summary({ id: 'tmdb-tv:2' });
    expect(mergeResults([[a], [b, a], []]).map((t) => t.id)).toEqual(['anilist:1', 'tmdb-tv:2']);
  });
});

describe('lookupFailure', () => {
  it('turns refusals into gentle messages', () => {
    expect(lookupFailure(new NasHttpError(429, 'too-many-lookups', { retryAfter: 12 }))).toBe('Searching too fast, try again in 12 s');
    expect(lookupFailure(new NasHttpError(429, 'lookup-busy'))).toBe('Searching too fast, try again in 1 s');
    expect(lookupFailure(new NasHttpError(503, 'source-unreachable'))).toBe("AniList or TMDB couldn't be reached");
    expect(lookupFailure(new Error('boom'))).toBe('boom');
  });
});

describe('skippedText', () => {
  it('says why a disc kept its own choice', () => {
    expect(skippedText('direct')).toBe('filed separately');
    expect(skippedText('copy')).toBe('follows its copy');
  });
});
