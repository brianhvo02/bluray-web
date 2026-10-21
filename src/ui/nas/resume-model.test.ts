import { describe, expect, it } from 'vitest';
import type { ContinueItem, DiscPlaces, PlaceSettings, PlaybackPlace } from '../../engine/disc/nas-api';
import { carriedSettings, continueCard, episodeProgress, resumeOffer, startOver, UNTITLED_DISC } from './resume-model';

const settings: PlaceSettings = {
  audioLanguage: 'jpn', pgLanguage: 'eng', textFiles: [], psr1: 2, psr2: 0x80000001, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 0.8, muted: false,
};
const place = (playlistId: string, over: Partial<PlaybackPlace> = {}): PlaybackPlace => ({
  discKey: 'f.AB', discId: 'd1', playlistId, timeUs: 60_000_000, durationUs: 1_440_000_000, finished: false, mode: 'none', title: null,
  psrs: [], gprs: null, settings, updatedAt: 1000, deviceName: 'iPad', ...over,
});
const disc = (...places: PlaybackPlace[]): DiscPlaces => ({ defaults: places[0]?.settings ?? null, places: Object.fromEntries(places.map((p) => [p.playlistId, p])) });
const PLAYLISTS = [{ id: '00001', durationUs: 1_440_000_000 }, { id: '00002', durationUs: 1_440_000_000 }];

describe('resumeOffer', () => {
  it("offers the requested playlist's own place", () => {
    const offer = resumeOffer(disc(place('00001'), place('00002', { updatedAt: 2000 })), '00001', PLAYLISTS);
    expect(offer).toMatchObject({ kind: 'ask', place: { playlistId: '00001' }, start: { playlistId: '00001', timeUs: 60_000_000 } });
  });

  it("offers the disc's newest unfinished place when no playlist is requested", () => {
    const offer = resumeOffer(disc(place('00001'), place('00002', { updatedAt: 3000, finished: true }), place('00003', { updatedAt: 2000 })), null, null);
    expect(offer).toMatchObject({ kind: 'ask', place: { playlistId: '00003' } });
  });

  it('offers nothing for a finished place, no place or no places at all', () => {
    expect(resumeOffer(disc(place('00001', { finished: true })), '00001', PLAYLISTS)).toEqual({ kind: 'none' });
    expect(resumeOffer(disc(place('00002')), '00001', PLAYLISTS)).toEqual({ kind: 'none' });
    expect(resumeOffer(null, null, PLAYLISTS)).toEqual({ kind: 'none' });
  });

  it('says the disc changed when the playlist is gone or the time is past its end', () => {
    expect(resumeOffer(disc(place('00042')), null, PLAYLISTS)).toMatchObject({ kind: 'changed' });
    expect(resumeOffer(disc(place('00001', { timeUs: 2_000_000_000 })), '00001', PLAYLISTS)).toMatchObject({ kind: 'changed' });
  });
});

it("starts over at the place's playlist with its audio, subtitle and angle", () => {
  expect(startOver(place('00002'))).toEqual({ playlistId: '00002', timeUs: 0, hdmv: null, playback: { psr1: 2, psr2: 0x80000001, psr3: 1 } });
});

const item = (over: Partial<ContinueItem> = {}): ContinueItem => ({
  kind: 'resume', discKey: 'f.AB', discId: 'd1', playlistId: '00001', timeUs: 15 * 60_000_000, durationUs: 24 * 60_000_000,
  titleId: 't', titleName: 'Starfall Wanderer', poster: null, seasonId: 's1', seasonNumber: 1, episode: 3, kindOfTitle: 'series',
  updatedAt: 1, deviceName: 'iPad', settings: null, ...over,
});

describe('continueCard', () => {
  it('reads "S1 · Episode 3 · 9 min left" with a bar for a series episode', () => {
    expect(continueCard(item(), null)).toEqual({ title: 'Starfall Wanderer', line: 'S1 · Episode 3 · 9 min left', percent: 63 });
  });

  it('reads "Movie · 1 h 31 min left" for a movie', () => {
    const movie = item({ kindOfTitle: 'movie', seasonNumber: null, episode: null, timeUs: 29 * 60_000_000, durationUs: 120 * 60_000_000 });
    expect(continueCard(movie, null).line).toBe('Movie · 1 h 31 min left');
    expect(continueCard({ ...movie, durationUs: 125 * 60_000_000, timeUs: 60 * 60_000_000 }, null).line).toBe('Movie · 1 h 05 min left');
  });

  it('reads "Up next · S1 · Episode 4" with no bar', () => {
    expect(continueCard(item({ kind: 'up-next', episode: 4, timeUs: 0 }), null)).toEqual({ title: 'Starfall Wanderer', line: 'Up next · S1 · Episode 4', percent: null });
  });

  it("names a card with no title by its disc, else as an untitled disc", () => {
    const unknown = item({ titleName: null, titleId: null, seasonNumber: null, episode: null, kindOfTitle: null });
    expect(continueCard(unknown, 'Vol.1')).toMatchObject({ title: 'Vol.1', line: '9 min left' });
    expect(continueCard(unknown, null).title).toBe(UNTITLED_DISC);
  });
});

describe('carriedSettings', () => {
  const upNext = item({ kind: 'up-next', discId: 'd2', playlistId: '00004', settings: { ...settings, shaderSet: 'Mode A' } });
  it("takes an Up next card's settings for its episode, else the disc's defaults", () => {
    expect(carriedSettings([upNext], 'd2', '00004', null)?.shaderSet).toBe('Mode A');
    expect(carriedSettings([upNext], 'd2', '00005', disc(place('00001')))).toBe(settings);
    expect(carriedSettings(null, 'd2', '00004', null)).toBeNull();
  });
});

it('shows episode progress only for an unfinished place', () => {
  const progress = { d1: { '00001': { timeUs: 6e8, durationUs: 1.2e9, finished: false }, '00002': { timeUs: 1.2e9, durationUs: 1.2e9, finished: true } } };
  expect(episodeProgress(progress, 'd1', '00001')).toBe(50);
  expect(episodeProgress(progress, 'd1', '00002')).toBeNull();
  expect(episodeProgress(progress, 'd2', '00001')).toBeNull();
  expect(episodeProgress(null, 'd1', '00001')).toBeNull();
});
