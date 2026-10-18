import { describe, expect, it } from 'vitest';
import type { OwnerChoice, OwnTitle } from '../../../src/engine/disc/nas-api';
import { buildCatalogue } from './catalogue';
import type { Catalogue } from './catalogue';
import type { DiscDbHit } from './discdb';
import type { DiscEvidence } from './evidence';
import type { DiscMatch } from './match';
import type { OwnerSnapshot } from './owner-store';
import type { Entry, EntryNames } from './sources';

// Every title and path here is made up (ruling R4).

function entry(id: string, names: Partial<EntryNames>, more: Partial<Entry> = {}): Entry {
  const source = id.startsWith('anilist:') ? 'anilist' : 'tmdb';
  return {
    source,
    id,
    kind: id.startsWith('tmdb-movie:') ? 'movie' : 'series',
    format: source === 'anilist' ? 'TV' : null,
    names: { english: null, romaji: null, native: null, synonyms: [], ...names },
    animation: true,
    year: null,
    episodes: null,
    runtimeMin: null,
    seasons: [],
    relations: [],
    poster: null,
    banner: null,
    ...more,
  };
}

type Playlist = DiscEvidence['playlists'][number];
const pl = (id: string, minutes: number, clips: readonly string[]): Playlist => ({ id, durationS: minutes * 60, chapters: 6, clips });
/** Three 24-minute episodes and a play-all. */
const THREE_EPISODES = [pl('00001', 24, ['00001']), pl('00002', 24, ['00002']), pl('00003', 24, ['00003']), pl('00004', 72, ['00001', '00002', '00003'])];

const id = (path: string): string => `id:${path}`;

function ev(path: string, more: Partial<DiscEvidence> = {}): DiscEvidence {
  return { discId: id(path), path, fingerprint: null, discTitles: [], segments: path.split('/').slice(1), catalogueNumbers: [], playlists: [], ...more };
}

const filed = (path: string, entryId: string, season: number | null, disc: number | null, bonus = false): DiscMatch =>
  ({ discId: id(path), status: 'filed', entryId, season, disc, bonus, via: ['folder'] });

function owner(choices: Record<string, OwnerChoice> = {}, ownTitles: OwnTitle[] = [], displayNames: Record<string, string> = {}): OwnerSnapshot {
  return { choices: new Map(Object.entries(choices)), ownTitles, displayNames: new Map(Object.entries(displayNames)), gate: null };
}

function build(input: {
  matches: DiscMatch[];
  entries?: Entry[];
  evidence: DiscEvidence[];
  owner?: OwnerSnapshot;
  discdb?: Record<string, DiscDbHit>;
  addedAt?: Record<string, number>;
}): Catalogue {
  return buildCatalogue({
    matches: input.matches,
    entries: new Map((input.entries ?? []).map((en) => [en.id, en])),
    evidence: input.evidence,
    owner: input.owner ?? owner(),
    discdb: { lookup: (fp) => input.discdb?.[fp] ?? null },
    addedAt: new Map(Object.entries(input.addedAt ?? {})),
  });
}

// An AniList chain whose ids don't follow its start dates: 300 (2019) → 120 (2021) → 450 (2023), and a film after 120.
const S1 = entry('anilist:300', { english: 'Ember Blade', native: '火斬りの剣' }, {
  year: 2019, episodes: 3, runtimeMin: 24, poster: { small: 'https://img.example/s/300.jpg', large: 'https://img.example/l/300.jpg' }, banner: 'https://img.example/b/300.jpg',
  relations: [{ type: 'SEQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }],
});
const S2 = entry('anilist:120', { english: 'Ember Blade Season 2', romaji: 'Hinokiri no Ken 2' }, {
  year: 2021,
  relations: [
    { type: 'PREQUEL', id: 'anilist:300', format: 'TV', startDate: 20190405 },
    { type: 'SEQUEL', id: 'anilist:450', format: 'TV', startDate: 20230701 },
    { type: 'SEQUEL', id: 'anilist:500', format: 'MOVIE', startDate: 20220101 },
  ],
});
const S3 = entry('anilist:450', { romaji: 'Hinokiri no Ken: Kanketsu-hen' }, { year: 2023, relations: [{ type: 'PREQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
const FILM = entry('anilist:500', { english: 'Ember Blade: Ashfall' }, { kind: 'movie', format: 'MOVIE', year: 2022, relations: [{ type: 'PREQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
const HARBOR = entry('tmdb-tv:7', { english: 'Harbor Line' }, { seasons: [1, 2, 3, 4, 5].map((n) => ({ number: n, episodes: 3, runtimeMin: 24 })) });

describe('buildCatalogue', () => {
  const chain = () => build({
    entries: [S3, FILM, S1, S2],
    evidence: [ev('drv5/Ember Blade/S1D1'), ev('drv5/Ember Blade/S2D1'), ev('drv5/Ember Blade/S3D1'), ev('drv5/Ember Blade/Ashfall')],
    matches: [
      filed('drv5/Ember Blade/S1D1', 'anilist:300', 1, 1),
      filed('drv5/Ember Blade/S2D1', 'anilist:120', 2, 1),
      filed('drv5/Ember Blade/S3D1', 'anilist:450', 3, 1),
      filed('drv5/Ember Blade/Ashfall', 'anilist:500', null, null),
    ],
  });

  it('makes one series of an AniList SEQUEL chain, seasons ordered by start date and labelled by their names', () => {
    const cat = chain();
    const series = cat.titles.filter((t) => t.kind === 'series');
    expect(series.map((t) => t.id)).toEqual(['anilist:300']);
    expect(series[0]).toMatchObject({ seasons: 3, discs: 3, own: false, year: 2019, names: { english: 'Ember Blade', native: '火斬りの剣', display: null } });
    const detail = cat.detail('anilist:300')!;
    expect(detail.seasons.map((s) => [s.number, s.label, s.discs[0]!.copies[0]!.discId])).toEqual([
      [1, 'Ember Blade', id('drv5/Ember Blade/S1D1')],
      [2, 'Ember Blade Season 2', id('drv5/Ember Blade/S2D1')],
      [3, 'Hinokiri no Ken: Kanketsu-hen', id('drv5/Ember Blade/S3D1')],
    ]);
    expect(detail.seasons[0]!.discs[0]).toEqual({ number: 1, label: 'Disc 1', copies: [{ discId: id('drv5/Ember Blade/S1D1'), root: 'drv5', folder: 'Ember Blade/S1D1', displayName: null }] });
  });

  it('lists a related film under the series and not on its own', () => {
    const cat = chain();
    expect(cat.titles.map((t) => t.id)).not.toContain('anilist:500');
    const detail = cat.detail('anilist:300')!;
    expect(detail.related.map((t) => [t.id, t.kind])).toEqual([['anilist:500', 'movie']]);
    const film = cat.detail('anilist:500')!;
    expect(film.seasons).toEqual([{ id: expect.any(String), label: '', number: null, discs: [expect.objectContaining({ copies: [expect.objectContaining({ discId: id('drv5/Ember Blade/Ashfall') })] })], episodes: null, extras: [] }]);
  });

  it('lists a film with no series as a movie title', () => {
    const cat = build({ entries: [FILM], evidence: [ev('drv5/Ashfall/BD')], matches: [filed('drv5/Ashfall/BD', 'anilist:500', null, null)] });
    expect(cat.titles.map((t) => [t.id, t.kind])).toEqual([['anilist:500', 'movie']]);
  });

  it('never invents a season missing from the entries', () => {
    const cat = build({
      entries: [S1, S3],
      evidence: [ev('drv5/Ember Blade/S1D1'), ev('drv5/Ember Blade/S3D1')],
      matches: [filed('drv5/Ember Blade/S1D1', 'anilist:300', 1, 1), filed('drv5/Ember Blade/S3D1', 'anilist:450', 3, 1)],
    });
    expect(cat.detail('anilist:300')!.seasons.map((s) => s.number)).toEqual([1]);
    // the season's number still follows the matcher, which saw the whole chain
    expect(cat.detail('anilist:450')!.seasons.map((s) => [s.number, s.label])).toEqual([[3, 'Hinokiri no Ken: Kanketsu-hen']]);
  });

  it('gives a TMDB TV entry one series with its seasons', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('drv2/Harbor Line S2/D1'), ev('drv2/Harbor Line S1/D1'), ev('drv2/Harbor Line S1/D2')],
      matches: [filed('drv2/Harbor Line S2/D1', 'tmdb-tv:7', 2, 1), filed('drv2/Harbor Line S1/D1', 'tmdb-tv:7', 1, 1), filed('drv2/Harbor Line S1/D2', 'tmdb-tv:7', 1, 2)],
    });
    expect(cat.titles.map((t) => [t.id, t.kind, t.seasons, t.discs])).toEqual([['tmdb-tv:7', 'series', 2, 3]]);
    expect(cat.detail('tmdb-tv:7')!.seasons.map((s) => [s.number, s.label, s.discs.map((d) => d.number)])).toEqual([[1, 'Season 1', [1, 2]], [2, 'Season 2', [1]]]);
  });

  it('lists two discs filed as the same season and disc as copies of one disc, BDMVs before Downloads', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('drv1-dl/Harbor.Line.S05.BluRay/DISC1'), ev('drv7/Harbor Line/Season 5/Disc 1')],
      matches: [filed('drv1-dl/Harbor.Line.S05.BluRay/DISC1', 'tmdb-tv:7', 5, 1), filed('drv7/Harbor Line/Season 5/Disc 1', 'tmdb-tv:7', 5, 1)],
    });
    const season = cat.detail('tmdb-tv:7')!.seasons[0]!;
    expect(season.discs).toHaveLength(1);
    expect(season.discs[0]!.copies.map((c) => [c.root, c.folder])).toEqual([['drv7', 'Harbor Line/Season 5/Disc 1'], ['drv1-dl', 'Harbor.Line.S05.BluRay/DISC1']]);
    expect(cat.titles[0]!.discs).toBe(1);
  });

  it('guesses episodes from playlists, and a TheDiscDB hit\'s episodes win over the guess', () => {
    const one = entry('tmdb-tv:8', { english: 'Quiet Orchard' }, { seasons: [{ number: 1, episodes: 3, runtimeMin: 24 }] });
    const disc = ev('drv3/Quiet Orchard/D1', { fingerprint: 'FP1', playlists: THREE_EPISODES });
    const input = { entries: [one], evidence: [disc], matches: [filed(disc.path, 'tmdb-tv:8', 1, 1)] };
    const guessed = build(input).detail('tmdb-tv:8')!.seasons[0]!.episodes!;
    expect(guessed.map((e) => [e.number, e.name, e.playlistId])).toEqual([[1, null, '00001'], [2, null, '00002'], [3, null, '00003']]);
    const hit: DiscDbHit = {
      title: 'Quiet Orchard', year: null, kind: 'series', tmdbId: '8', season: 1,
      episodes: [
        { playlist: '00003', season: 1, episode: 1, name: 'Seedlings' },
        { playlist: '00001', season: 1, episode: 2, name: 'Rain' },
        { playlist: '00002', season: 1, episode: 3, name: null },
      ],
    };
    const fromHit = build({ ...input, discdb: { FP1: hit } }).detail('tmdb-tv:8')!.seasons[0]!.episodes!;
    expect(fromHit).toEqual([
      { number: 1, name: 'Seedlings', runtimeMin: 24, discId: disc.discId, playlistId: '00003' },
      { number: 2, name: 'Rain', runtimeMin: 24, discId: disc.discId, playlistId: '00001' },
      { number: 3, name: null, runtimeMin: 24, discId: disc.discId, playlistId: '00002' },
    ]);
  });

  it('hides the Episodes tab when the guess does not add up', () => {
    const cat = build({ entries: [HARBOR], evidence: [ev('drv2/H/D1', { playlists: THREE_EPISODES.slice(0, 2) })], matches: [filed('drv2/H/D1', 'tmdb-tv:7', 1, 1)] });
    expect(cat.detail('tmdb-tv:7')!.seasons[0]!.episodes).toBeNull();
  });

  it('puts a bonus disc with a known season in that season\'s extras, and one without in the title\'s', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('drv2/Harbor Line S2/D1'), ev('drv2/Harbor Line S2/Bonus'), ev('drv2/Harbor Line/Extras')],
      matches: [filed('drv2/Harbor Line S2/D1', 'tmdb-tv:7', 2, 1), filed('drv2/Harbor Line S2/Bonus', 'tmdb-tv:7', 2, null, true), filed('drv2/Harbor Line/Extras', 'tmdb-tv:7', null, null, true)],
    });
    const detail = cat.detail('tmdb-tv:7')!;
    expect(detail.seasons).toHaveLength(1);
    expect(detail.seasons[0]!.discs.map((d) => d.copies[0]!.discId)).toEqual([id('drv2/Harbor Line S2/D1')]);
    expect(detail.seasons[0]!.extras.map((d) => d.copies[0]!.discId)).toEqual([id('drv2/Harbor Line S2/Bonus')]);
    expect(detail.extras.map((d) => d.copies[0]!.discId)).toEqual([id('drv2/Harbor Line/Extras')]);
  });

  it('makes music titles of music matches, grouped by release folder', () => {
    const live = 'Music/[2024.05.01] Fictive Band - Night Tour [CD+BD]';
    const cat = build({
      evidence: [ev(`drv1-dl/${live}/BD1`), ev(`drv1-dl/${live}/BD2`), ev('drv1-dl/Music/Other Group - Spring/BDMV')],
      matches: [
        { discId: id(`drv1-dl/${live}/BD1`), status: 'music', group: live, name: '[2024.05.01] Fictive Band - Night Tour [CD+BD]' },
        { discId: id(`drv1-dl/${live}/BD2`), status: 'music', group: live, name: '[2024.05.01] Fictive Band - Night Tour [CD+BD]' },
        { discId: id('drv1-dl/Music/Other Group - Spring/BDMV'), status: 'music', group: 'Music/Other Group - Spring', name: 'Other Group - Spring' },
      ],
      owner: owner({}, [], {}),
    });
    const music = cat.titles.filter((t) => t.kind === 'music');
    expect(music).toHaveLength(2);
    expect(music.every((t) => /^music:[0-9a-f]+$/.test(t.id) && t.poster === null)).toBe(true);
    const tour = music.find((t) => t.names.english === '[2024.05.01] Fictive Band - Night Tour [CD+BD]')!;
    expect(tour.discs).toBe(2);
    const detail = cat.detail(tour.id)!;
    expect(detail.seasons.map((s) => [s.number, s.label, s.discs.length, s.episodes])).toEqual([[null, '', 2, null]]);
  });

  it('shows a music title\'s display name', () => {
    const group = 'Music/Other Group - Spring';
    const disc = ev(`drv1-dl/${group}/BDMV`);
    const input = { evidence: [disc], matches: [{ discId: disc.discId, status: 'music', group, name: 'Other Group - Spring' } as DiscMatch] };
    const musicId = build(input).titles[0]!.id;
    expect(build({ ...input, owner: owner({}, [], { [musicId]: 'Spring Live' }) }).titles[0]!.names.display).toBe('Spring Live');
  });

  it('lets an owner choice override a match', () => {
    const cat = build({
      entries: [S1, HARBOR],
      evidence: [ev('drv5/Mixed/D3')],
      matches: [filed('drv5/Mixed/D3', 'anilist:300', 1, 1)],
      owner: owner({ [id('drv5/Mixed/D3')]: { kind: 'title', titleId: 'tmdb-tv:7', season: 2, disc: 3 } }),
    });
    expect(cat.titles.map((t) => t.id)).toEqual(['tmdb-tv:7']);
    expect(cat.detail('tmdb-tv:7')!.seasons.map((s) => [s.number, s.discs.map((d) => [d.number, d.label])])).toEqual([[2, [[3, 'Disc 3']]]]);
    expect(cat.detail('anilist:300')).toBeNull();
  });

  it('files an owner choice by season number within an AniList series', () => {
    const cat = build({
      entries: [S1, S2, S3],
      evidence: [ev('drv5/E/A'), ev('drv5/E/B')],
      matches: [filed('drv5/E/A', 'anilist:300', 1, 1), { discId: id('drv5/E/B'), status: 'unsorted', reason: 'no-season', suggestions: ['anilist:300'] }],
      owner: owner({ [id('drv5/E/B')]: { kind: 'title', titleId: 'anilist:300', season: 3, disc: 2 } }),
    });
    expect(cat.detail('anilist:300')!.seasons.map((s) => [s.number, s.discs.map((d) => d.number)])).toEqual([[1, [1]], [3, [2]]]);
  });

  it('removes a hidden disc from every title and lists it in hidden', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('drv2/Harbor Line S1/D1'), ev('drv2/Harbor Line S1/D2')],
      matches: [filed('drv2/Harbor Line S1/D1', 'tmdb-tv:7', 1, 1), filed('drv2/Harbor Line S1/D2', 'tmdb-tv:7', 1, 2)],
      owner: owner({ [id('drv2/Harbor Line S1/D2')]: { kind: 'hidden' } }, [], { [id('drv2/Harbor Line S1/D2')]: 'Sample disc' }),
    });
    expect(cat.detail('tmdb-tv:7')!.seasons[0]!.discs.map((d) => d.number)).toEqual([1]);
    expect(cat.hidden).toEqual([{ discId: id('drv2/Harbor Line S1/D2'), root: 'drv2', folder: 'Harbor Line S1/D2', displayName: 'Sample disc' }]);
    expect(cat.unsorted).toEqual([]);
  });

  it('lists an own title with own: true and no poster', () => {
    const tapes: OwnTitle = { id: 'own:5f0c', kind: 'movie', name: 'Garden Tapes', seasons: null };
    const cat = build({
      evidence: [ev('drv0/Home/Garden')],
      matches: [{ discId: id('drv0/Home/Garden'), status: 'unsorted', reason: 'no-title', suggestions: [] }],
      owner: owner({ [id('drv0/Home/Garden')]: { kind: 'title', titleId: 'own:5f0c', season: null, disc: null } }, [tapes]),
    });
    expect(cat.titles).toEqual([{
      id: 'own:5f0c', kind: 'movie', names: { english: null, romaji: null, native: null, synonyms: [], display: 'Garden Tapes' },
      poster: null, year: null, seasons: 0, discs: 1, addedAt: 0, own: true,
    }]);
    expect(cat.detail('own:5f0c')!.seasons[0]!.discs[0]!.copies[0]!.discId).toBe(id('drv0/Home/Garden'));
    expect(cat.unsorted).toEqual([]);
  });

  it('keeps a disc filed under an entry that is not loaded yet in Unsorted', () => {
    const cat = build({
      evidence: [ev('drv5/Later/D1')],
      matches: [{ discId: id('drv5/Later/D1'), status: 'unsorted', reason: 'several-fit', suggestions: [] }],
      owner: owner({ [id('drv5/Later/D1')]: { kind: 'title', titleId: 'anilist:999', season: null, disc: 1 } }),
    });
    expect(cat.titles).toEqual([]);
    expect(cat.unsorted.map((u) => [u.discId, u.reason])).toEqual([[id('drv5/Later/D1'), 'no-title']]);
  });

  it('lists Unsorted discs with their reason, suggestions, folder group and catalogue number', () => {
    const cat = build({
      entries: [S2, HARBOR],
      evidence: [
        ev('drv5/Mystery Box/D1', { discTitles: [{ lang: 'jpn', name: '謎の箱' }], catalogueNumbers: ['ABCD-1234'] }),
        ev('drv5/Mystery Box/D2'),
      ],
      matches: [
        { discId: id('drv5/Mystery Box/D1'), status: 'unsorted', reason: 'several-fit', suggestions: ['anilist:120', 'tmdb-tv:7', 'anilist:404'] },
        filed('drv5/Mystery Box/D2', 'tmdb-tv:7', 1, 2),
      ],
    });
    expect(cat.unsorted).toEqual([{
      discId: id('drv5/Mystery Box/D1'), path: 'drv5/Mystery Box/D1', discTitles: [{ lang: 'jpn', name: '謎の箱' }], reason: 'several-fit',
      suggestions: [expect.objectContaining({ id: 'anilist:120', names: expect.objectContaining({ english: 'Ember Blade Season 2' }) }), expect.objectContaining({ id: 'tmdb-tv:7' })],
      catalogueNumber: 'ABCD-1234', group: 'drv5/Mystery Box', groupSize: 2,
    }]);
  });

  it('gives titles art ids, never source URLs, and maps them back', () => {
    const cat = chain();
    const json = JSON.stringify([cat.titles, cat.detail('anilist:300')]);
    expect(json).not.toContain('img.example');
    const title = cat.titles.find((t) => t.id === 'anilist:300')!;
    expect(cat.art(title.poster!)).toEqual({ small: 'https://img.example/s/300.jpg', large: 'https://img.example/l/300.jpg' });
    expect(cat.art(cat.detail('anilist:300')!.banner!)).toEqual({ small: 'https://img.example/b/300.jpg', large: 'https://img.example/b/300.jpg' });
    expect(cat.art('nope')).toBeNull();
  });

  it('dates a title by its newest disc', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('drv2/H/D1'), ev('drv2/H/D2')],
      matches: [filed('drv2/H/D1', 'tmdb-tv:7', 1, 1), filed('drv2/H/D2', 'tmdb-tv:7', 1, 2)],
      addedAt: { [id('drv2/H/D1')]: 1000, [id('drv2/H/D2')]: 5000 },
    });
    expect(cat.titles[0]!.addedAt).toBe(5000);
  });
});
