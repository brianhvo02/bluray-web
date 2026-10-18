import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '../../../src/engine/disc/title-text';
import type { DiscDbHit } from './discdb';
import type { DiscEvidence } from './evidence';
import { groupKey, matchDiscs } from './match';
import type { DiscMatch, MatchContext } from './match';
import { SourceUnavailable } from './sources';
import type { Entry, EntryNames, MetadataSource } from './sources';

// Every title here is made up (ruling T5a).

function entry(id: string, names: Partial<EntryNames>, more: Partial<Entry> = {}): Entry {
  const source = id.startsWith('anilist:') ? 'anilist' : 'tmdb';
  return {
    source,
    id,
    kind: id.startsWith('tmdb-movie:') ? 'movie' : 'series',
    format: source === 'anilist' ? 'TV' : null,
    names: { english: null, romaji: null, native: null, synonyms: [], ...names },
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

const seasons = (n: number, episodes = 12): Entry['seasons'] =>
  Array.from({ length: n }, (_, i) => ({ number: i + 1, episodes, runtimeMin: 24 }));

/** A source answering fixed entries per normalised query, recording every call. */
function fake(results: Record<string, Entry[]>, fail: readonly string[] = []): MetadataSource & { calls: string[] } {
  const byKey = new Map(Object.entries(results).map(([q, es]) => [normalizeTitle(q), es]));
  const calls: string[] = [];
  return {
    calls,
    async search(query) {
      calls.push(normalizeTitle(query));
      if (fail.some((f) => normalizeTitle(f) === normalizeTitle(query))) throw new SourceUnavailable('down');
      return byKey.get(normalizeTitle(query)) ?? [];
    },
    async entry() {
      return null;
    },
  };
}

function ctx(anilist: MetadataSource, tmdb: MetadataSource | null, discdb: Record<string, DiscDbHit> = {}): MatchContext {
  return { anilist, tmdb, discdb: { lookup: (fp) => discdb[fp] ?? null }, cache: new Map() };
}

function ev(path: string, titles: Record<string, string> = {}, fingerprint: string | null = null): DiscEvidence {
  return {
    discId: `id:${path}`,
    path,
    fingerprint,
    discTitles: Object.entries(titles).map(([lang, name]) => ({ lang, name })),
    segments: path.split('/'),
    catalogueNumbers: [],
    playlists: [],
  };
}

const byDisc = (matches: readonly DiscMatch[], path: string): DiscMatch => {
  const m = matches.find((x) => x.discId === `id:${path}`);
  if (!m) throw new Error(`no match for ${path}`);
  return m;
};

const EMBER = entry('anilist:100', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' }, { episodes: 12 });

describe('groupKey', () => {
  it('is the parent folder of the disc folder or ISO', () => {
    expect(groupKey(ev('BDMVs/Citadel S02/CITADEL S02 VOL.2'))).toBe('BDMVs/Citadel S02');
    expect(groupKey(ev('Lone Disc.iso'))).toBe('');
  });
});

describe('matchDiscs', () => {
  it('files a disc when one AniList entry fits and the disc title and folder agree (rules 1-4)', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const path = 'Anime/[BDMV][220629][火斬りの剣][Vol.1]';
    const { matches, entries } = await matchDiscs([ev(path, { jpn: '火斬りの剣' })], ctx(anilist, null));
    expect(byDisc(matches, path)).toEqual({
      discId: `id:${path}`, status: 'filed', entryId: 'anilist:100', season: 1, disc: 1, bonus: false, via: ['disc-title', 'folder'],
    });
    expect(entries.get('anilist:100')).toBe(EMBER);
  });

  it('sends a disc to Unsorted when two entries fit equally (rule 1: several-fit)', async () => {
    const anilist = fake({ Citadel: [entry('anilist:200', { english: 'Citadel Season 2' })] });
    const tmdb = fake({ Citadel: [entry('tmdb-movie:201', { english: 'Citadel' }, { year: 2019 })] });
    const path = 'BDMVs/[BDMV] Citadel';
    const { matches, entries } = await matchDiscs([ev(path, { eng: 'Citadel' })], ctx(anilist, tmdb));
    const m = byDisc(matches, path);
    expect(m).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
    expect(m.status === 'unsorted' && [...m.suggestions].sort()).toEqual(['anilist:200', 'tmdb-movie:201']);
    expect([...entries.keys()].sort()).toEqual(['anilist:200', 'tmdb-movie:201']);
  });

  it('needs a season number for a TMDB series with several seasons (rule 3: no-season)', async () => {
    const path = 'TV/Glass Orchard/GLASS_ORCHARD_D1';
    const several = fake({ 'Glass Orchard': [entry('tmdb-tv:300', { english: 'Glass Orchard' }, { seasons: seasons(3) })] });
    const r1 = await matchDiscs([ev(path, { eng: 'Glass Orchard' })], ctx(fake({}), several));
    expect(byDisc(r1.matches, path)).toMatchObject({ status: 'unsorted', reason: 'no-season', suggestions: ['tmdb-tv:300'] });

    const single = fake({ 'Glass Orchard': [entry('tmdb-tv:300', { english: 'Glass Orchard' }, { seasons: seasons(1) })] });
    const r2 = await matchDiscs([ev(path, { eng: 'Glass Orchard' })], ctx(fake({}), single));
    expect(byDisc(r2.matches, path)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:300', season: 1, disc: 1 });
  });

  it('rejects an episode range past the season (rule 3: episode-past-season)', async () => {
    const anilist = fake({ 'Starfall Traveler': [entry('anilist:400', { english: 'Starfall Traveler' }, { episodes: 12 })] });
    const path = 'Anime/[BDMV] Starfall Traveler/[BDMV] Starfall Traveler Vol.5 [第13話]';
    const { matches } = await matchDiscs([ev(path, { eng: 'Starfall Traveler' })], ctx(anilist, null));
    expect(byDisc(matches, path)).toMatchObject({ status: 'unsorted', reason: 'episode-past-season', suggestions: ['anilist:400'] });
  });

  it('numbers unnumbered siblings only when the folder gives the release disc count (rule 4)', async () => {
    const harbor = entry('anilist:500', { english: 'Harbor Line' }, { episodes: 12 });
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const group = (parent: string): DiscEvidence[] =>
      [...letters].reverse().map((l) => ev(`Anime/${parent}/HARBOR_LINE_${l}`, { jpn: 'Harbor Line' }));

    const unknown = await matchDiscs(group('[BDMV] Harbor Line'), ctx(fake({ 'Harbor Line': [harbor] }), null));
    for (const m of unknown.matches) expect(m).toMatchObject({ status: 'unsorted', reason: 'no-disc-number', suggestions: ['anilist:500'] });

    const known = await matchDiscs(group('[BDMV] Harbor Line Vol.1-6 Fin'), ctx(fake({ 'Harbor Line': [harbor] }), null));
    letters.forEach((l, i) => {
      expect(byDisc(known.matches, `Anime/[BDMV] Harbor Line Vol.1-6 Fin/HARBOR_LINE_${l}`)).toMatchObject({ status: 'filed', entryId: 'anilist:500', season: 1, disc: i + 1 });
    });

    // five of the six discs: their order doesn't say which one is missing
    const short = await matchDiscs(group('[BDMV] Harbor Line Vol.1-6 Fin').slice(1), ctx(fake({ 'Harbor Line': [harbor] }), null));
    for (const m of short.matches) expect(m).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });
  });

  it('sends a disc to Unsorted when TheDiscDB names a different title from the folder (rule 2: sources-disagree)', async () => {
    const tmdb = fake({
      'Quiet Meadow': [entry('tmdb-movie:600', { english: 'Quiet Meadow' })],
      'Lantern Coast': [entry('tmdb-movie:999', { english: 'Lantern Coast' })],
    });
    const hit: DiscDbHit = { title: 'Lantern Coast', year: 2011, kind: 'movie', tmdbId: '999', season: null, episodes: [] };
    const path = 'Movies/Quiet Meadow';
    const { matches } = await matchDiscs([ev(path, {}, 'FP1')], ctx(fake({}), tmdb, { FP1: hit }));
    const m = byDisc(matches, path);
    expect(m).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });
    expect(m.status === 'unsorted' && m.suggestions).toContain('tmdb-movie:600');
  });

  it('files a disc when TheDiscDB agrees with the folder', async () => {
    const tmdb = fake({ 'Quiet Meadow': [entry('tmdb-movie:600', { english: 'Quiet Meadow' })] });
    const hit: DiscDbHit = { title: 'Quiet Meadow', year: 2011, kind: 'movie', tmdbId: '600', season: null, episodes: [] };
    const path = 'Movies/Quiet Meadow';
    const { matches } = await matchDiscs([ev(path, {}, 'FP1')], ctx(fake({}), tmdb, { FP1: hit }));
    expect(byDisc(matches, path)).toEqual({
      discId: `id:${path}`, status: 'filed', entryId: 'tmdb-movie:600', season: null, disc: null, bonus: false, via: ['folder', 'discdb'],
    });
  });

  it('lets loose discs inherit the group folder\'s title', async () => {
    const tmdb = fake({ Citadel: [entry('tmdb-tv:700', { english: 'Citadel' }, { seasons: seasons(3) })] });
    const loose = 'TV/CITADEL S02/CITADEL S02 VOL.2';
    const bare = 'TV/CITADEL S02/DISC3';
    const { matches } = await matchDiscs([ev(loose), ev(bare)], ctx(fake({}), tmdb));
    expect(byDisc(matches, loose)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:700', season: 2, disc: 2, via: ['folder'] });
    expect(byDisc(matches, bare)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:700', season: 2, disc: 3, via: ['folder'] });
    expect(tmdb.calls.filter((q) => q === 'citadel')).toHaveLength(1);
  });

  it('files a foreign edition under the Japanese release\'s entry or not at all (Review Focus 1)', async () => {
    const anilist = fake({
      火斬りの剣: [EMBER],
      'Ember Blade: Hinokiri no Ken': [EMBER, entry('anilist:150', { english: 'Ember Blade Chronicles' })],
      'Hinokiri no Ken': [EMBER, entry('anilist:151', { romaji: 'Hinokiri no Ken Gaiden' })],
    });
    const tmdb = fake({ 'Ember Blade: Hinokiri no Ken': [entry('tmdb-tv:152', { english: 'Ember Blade' }, { seasons: seasons(1) })] });
    const jp = 'Anime/[BDMV][220629][火斬りの剣][Vol.1]';
    const ita = 'Anime/[BDMV] Hinokiri no Ken [Dist][ITA]';
    const { matches } = await matchDiscs([ev(jp, { jpn: '火斬りの剣' }), ev(ita, { ita: 'Ember Blade: Hinokiri no Ken' })], ctx(anilist, tmdb));
    expect(byDisc(matches, jp)).toMatchObject({ status: 'filed', entryId: 'anilist:100' });
    const m = byDisc(matches, ita);
    expect(m.status === 'filed' || m.status === 'unsorted').toBe(true);
    if (m.status === 'filed') expect(m.entryId).toBe('anilist:100');
  });

  it('puts discs under a Music folder or with a CD tag on the Music shelf, grouped by release folder', async () => {
    const anilist = fake({});
    const d1 = 'Music/Lumen Choir - First Light/DISC1';
    const d2 = 'Music/Lumen Choir - First Light/DISC2';
    const cd = 'Downloads/Lumen Choir - Night Songs [CD]';
    const { matches } = await matchDiscs([ev(d1), ev(d2), ev(cd)], ctx(anilist, fake({})));
    expect(byDisc(matches, d1)).toEqual({ discId: `id:${d1}`, status: 'music', group: 'Music/Lumen Choir - First Light', name: 'Lumen Choir - First Light' });
    expect(byDisc(matches, d2)).toMatchObject({ status: 'music', group: 'Music/Lumen Choir - First Light' });
    expect(byDisc(matches, cd)).toEqual({ discId: `id:${cd}`, status: 'music', group: cd, name: 'Lumen Choir - Night Songs [CD]' });
    expect(anilist.calls).toEqual([]);
  });

  it('files a bonus disc with a resolved title as bonus', async () => {
    const anilist = fake({ 'Starfall Traveler': [entry('anilist:400', { english: 'Starfall Traveler' }, { episodes: 12 })] });
    const path = 'Anime/[BDMV] Starfall Traveler/Starfall Traveler 特典';
    const { matches } = await matchDiscs([ev(path, { eng: 'Starfall Traveler' })], ctx(anilist, null));
    expect(byDisc(matches, path)).toMatchObject({ status: 'filed', entryId: 'anilist:400', season: 1, disc: null, bonus: true });
  });

  it('marks a group source-unreachable when a source fails, and still matches the others', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER] }, ['Starfall Traveler']);
    const down = 'Anime/[BDMV] Starfall Traveler/[BDMV] Starfall Traveler Vol.1';
    const up = 'Anime2/[BDMV][220629][火斬りの剣][Vol.1]';
    const { matches } = await matchDiscs([ev(down, { eng: 'Starfall Traveler' }), ev(up, { jpn: '火斬りの剣' })], ctx(anilist, null));
    expect(byDisc(matches, down)).toEqual({ discId: `id:${down}`, status: 'unsorted', reason: 'source-unreachable', suggestions: [] });
    expect(byDisc(matches, up)).toMatchObject({ status: 'filed', entryId: 'anilist:100' });
  });

  it('sends a disc with no fitting entry to Unsorted (no-title)', async () => {
    const path = 'TV/Nothing Here';
    const { matches } = await matchDiscs([ev(path)], ctx(fake({}), fake({})));
    expect(byDisc(matches, path)).toEqual({ discId: `id:${path}`, status: 'unsorted', reason: 'no-title', suggestions: [] });
  });

  it('calls search at most once per source and candidate, through the cache', async () => {
    const harbor = entry('anilist:500', { english: 'Harbor Line' });
    const anilist = fake({ 'Harbor Line': [harbor] });
    const tmdb = fake({});
    const discs = ['A', 'B', 'C'].map((l) => ev(`Anime/[BDMV] Harbor Line Vol.1-3/HARBOR_LINE_${l}`, { jpn: 'Harbor Line' }));
    const c = ctx(anilist, tmdb);
    await matchDiscs(discs, c);
    for (const calls of [anilist.calls, tmdb.calls]) expect(new Set(calls).size).toBe(calls.length);
    await matchDiscs(discs, c);
    expect(new Set(anilist.calls).size).toBe(anilist.calls.length);
  });
});
