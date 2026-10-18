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
    animation: source === 'anilist' ? true : null,
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

/** TMDB's search answers carry no seasons; only the entry by id (`/tv/<id>`) has them. */
const searchShape = (en: Entry): Entry => (en.source === 'tmdb' && en.kind === 'series' ? { ...en, seasons: [] } : en);

/** A source answering fixed entries per normalised query, recording every call; TMDB series come as search shows them. */
function fake(results: Record<string, Entry[]>, fail: readonly string[] = [], more: readonly Entry[] = []): MetadataSource & { calls: string[] } {
  const byKey = new Map(Object.entries(results).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map([...Object.values(results).flat(), ...more].map((en) => [en.id, en]));
  const calls: string[] = [];
  return {
    calls,
    async search(query) {
      calls.push(normalizeTitle(query));
      if (fail.some((f) => normalizeTitle(f) === normalizeTitle(query))) throw new SourceUnavailable('down');
      return (byKey.get(normalizeTitle(query)) ?? []).map(searchShape);
    },
    async entry(id) {
      return byId.get(id) ?? null;
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
    expect(groupKey(ev('BDMVs/Brasswick S02/BRASSWICK S02 VOL.2'))).toBe('BDMVs/Brasswick S02');
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
    const anilist = fake({ Brasswick: [entry('anilist:200', { english: 'Brasswick Season 2' })] });
    const tmdb = fake({ Brasswick: [entry('tmdb-movie:201', { english: 'Brasswick' }, { year: 2019 })] });
    const path = 'BDMVs/[BDMV] Brasswick';
    const { matches, entries } = await matchDiscs([ev(path, { eng: 'Brasswick' })], ctx(anilist, tmdb));
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
    const tmdb = fake({ Brasswick: [entry('tmdb-tv:700', { english: 'Brasswick' }, { seasons: seasons(3) })] });
    const loose = 'TV/BRASSWICK S02/BRASSWICK S02 VOL.2';
    const bare = 'TV/BRASSWICK S02/DISC3';
    const { matches } = await matchDiscs([ev(loose), ev(bare)], ctx(fake({}), tmdb));
    expect(byDisc(matches, loose)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:700', season: 2, disc: 2, via: ['folder'] });
    expect(byDisc(matches, bare)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:700', season: 2, disc: 3, via: ['folder'] });
    expect(tmdb.calls.filter((q) => q === 'brasswick')).toHaveLength(1);
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

  describe('review scenarios (fix round 1)', () => {
    const prequel = (id: string): Entry['relations'][number] => ({ type: 'PREQUEL', id, format: 'TV', startDate: null });

    it('C1: a disc whose own title names another entry is sources-disagree, whatever the season', async () => {
      const brasswick = entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: seasons(3) });
      const tv = fake({ Brasswick: [brasswick], 'Lantern Coast': [entry('tmdb-tv:8', { english: 'Lantern Coast' }, { seasons: seasons(1) })] });
      const r1 = await matchDiscs([ev('TV/Brasswick S02/DISC1'), ev('TV/Brasswick S02/DISC2', { eng: 'Lantern Coast' })], ctx(fake({}), tv));
      expect(byDisc(r1.matches, 'TV/Brasswick S02/DISC1')).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:7', season: 2, disc: 1 });
      expect(byDisc(r1.matches, 'TV/Brasswick S02/DISC2')).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });

      const movie = fake({ Brasswick: [brasswick], 'Lantern Coast': [entry('tmdb-movie:8', { english: 'Lantern Coast' })] });
      const r2 = await matchDiscs([ev('TV/Brasswick S02/DISC2', { eng: 'Lantern Coast' })], ctx(fake({}), movie));
      expect(byDisc(r2.matches, 'TV/Brasswick S02/DISC2')).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });

      const s1 = entry('anilist:10', { english: 'Harbor Line' });
      const s2 = entry('anilist:11', { english: 'Harbor Line 2nd Season' }, { relations: [prequel('anilist:10')] });
      const anime = fake({ 'Harbor Line': [s1, s2], 'Starfall Traveler': [entry('anilist:40', { english: 'Starfall Traveler' })] });
      const path = 'Anime/[BDMV] Harbor Line 2nd Season/Vol.3';
      const r3 = await matchDiscs([ev(path, { jpn: 'Starfall Traveler' })], ctx(anime, null));
      expect(byDisc(r3.matches, path)).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });
    });

    it('C2: a match that holds only under vowel folding is partial, never exact', async () => {
      const anilist = fake({ 'Good Hunter': [entry('anilist:66', { english: 'God Hunter' })] });
      const tmdb = fake({ 'Good Hunter': [entry('tmdb-tv:67', { english: 'Good Hunter' }, { seasons: seasons(1) })] });
      const path = 'Anime/[BDMV] Good Hunter Vol.1';
      const r1 = await matchDiscs([ev(path, { jpn: 'Good Hunter' })], ctx(anilist, tmdb));
      expect(tmdb.calls).toContain(normalizeTitle('Good Hunter'));
      const m = byDisc(r1.matches, path);
      expect(m.status === 'filed' && m.entryId === 'anilist:66').toBe(false);

      const r2 = await matchDiscs([ev('Movies/Soul Harbor')], ctx(fake({}), fake({ 'Soul Harbor': [entry('tmdb-movie:9', { english: 'Sol Harbor' })] })));
      expect(byDisc(r2.matches, 'Movies/Soul Harbor')).toMatchObject({ status: 'unsorted', reason: 'no-title' });

      const r3 = await matchDiscs([ev('Movies/Sousou Harbor')], ctx(fake({}), fake({ 'Sousou Harbor': [entry('tmdb-movie:10', { english: 'Sōsō Harbor' })] })));
      expect(byDisc(r3.matches, 'Movies/Sousou Harbor')).toMatchObject({ status: 'unsorted' });
    });

    it('C2: romaji without macrons fits a name with macrons exactly', async () => {
      const kori = entry('anilist:70', { romaji: 'Kōri no Shiro' });
      const path = 'Anime/[BDMV] Kori no Shiro/[BDMV] Kori no Shiro Vol.2';
      const { matches } = await matchDiscs([ev(path)], ctx(fake({ 'Kori no Shiro': [kori] }), fake({})));
      expect(byDisc(matches, path)).toMatchObject({ status: 'filed', entryId: 'anilist:70', disc: 2 });
    });

    it('C3: category folders and folders too far up are never candidates', async () => {
      const tmdb = fake({
        Movies: [entry('tmdb-movie:5', { english: 'Movies' })],
        Documentaries: [entry('tmdb-movie:6', { english: 'Documentaries' })],
        Anime: [entry('tmdb-movie:7', { english: 'Anime' })],
        Brasswick: [entry('tmdb-movie:8', { english: 'Brasswick' })],
      });
      const paths = ['Movies/BDROM', 'Documentaries/Some Unknown Thing/BD_VIDEO', 'Shelf/Anime/BD_VIDEO', 'Shelf/Brasswick/Extra/Deep/BD_VIDEO'];
      const { matches } = await matchDiscs(paths.map((p) => ev(p)), ctx(fake({}), tmdb));
      for (const p of paths) expect(byDisc(matches, p)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
      expect(tmdb.calls).not.toContain('movies');
      expect(tmdb.calls).not.toContain('brasswick');
    });

    it('C4: an English-named foreign edition files under the Japanese release\'s AniList entry, or not at all (RF1)', async () => {
      const ember = entry('anilist:100', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' }, { episodes: 12, year: 2022 });
      const anilist = fake({ 火斬りの剣: [ember], 'Ember Blade': [ember] });
      const tmdb = fake({ 'Ember Blade': [entry('tmdb-tv:152', { english: 'Ember Blade' }, { seasons: seasons(1), year: 2022, animation: true })] });
      const jp = 'Anime/[BDMV][220629][火斬りの剣][Vol.1]';
      const ita = 'BDMVs/Ember Blade [ITA]/Ember Blade Vol.1';
      const { matches } = await matchDiscs([ev(jp, { jpn: '火斬りの剣' }), ev(ita, { ita: 'Ember Blade' })], ctx(anilist, tmdb));
      expect(byDisc(matches, jp)).toMatchObject({ status: 'filed', entryId: 'anilist:100' });
      const m = byDisc(matches, ita);
      expect(m.status === 'filed' || m.status === 'unsorted').toBe(true);
      if (m.status === 'filed') expect(m.entryId).toBe('anilist:100');
    });

    it('C4: AniList and TMDB fitting different things is several-fit; TMDB alone files', async () => {
      const ember = entry('anilist:100', { english: 'Ember Blade' }, { year: 2022 });
      const path = 'BDMVs/Ember Blade [ITA]/Ember Blade Vol.1';
      const film = fake({ 'Ember Blade': [entry('tmdb-movie:153', { english: 'Ember Blade' }, { year: 2022 })] });
      const r1 = await matchDiscs([ev(path, { ita: 'Ember Blade' })], ctx(fake({ 'Ember Blade': [ember] }), film));
      expect(byDisc(r1.matches, path)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });

      const older = fake({ 'Ember Blade': [entry('tmdb-tv:154', { english: 'Ember Blade' }, { seasons: seasons(1), year: 1998 })] });
      const r2 = await matchDiscs([ev(path, { ita: 'Ember Blade' })], ctx(fake({ 'Ember Blade': [ember] }), older));
      expect(byDisc(r2.matches, path)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });

      const only = fake({ 'Ember Blade': [entry('tmdb-tv:155', { english: 'Ember Blade' }, { seasons: seasons(1), year: 2022 })] });
      const r3 = await matchDiscs([ev(path, { ita: 'Ember Blade' })], ctx(fake({}), only));
      expect(byDisc(r3.matches, path)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:155', season: 1, disc: 1 });
    });

    it('I1: two boxes never put different discs in the same slot', async () => {
      const tmdb = (): MetadataSource => fake({ Brasswick: [entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: seasons(1) })] });
      const both = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 1/DISC2', 'TV/Brasswick BOX 2/DISC1'];
      const r1 = await matchDiscs(both.map((p) => ev(p)), ctx(fake({}), tmdb()));
      expect(r1.matches.map((m) => (m.status === 'filed' ? m.disc : m.status))).toEqual([1, 2, 3]);

      const gap = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 1/DISC3', 'TV/Brasswick BOX 2/DISC1'];
      const r3 = await matchDiscs(gap.map((p) => ev(p)), ctx(fake({}), tmdb()));
      expect(byDisc(r3.matches, 'TV/Brasswick BOX 2/DISC1')).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });

      const lastGap = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 2/DISC1', 'TV/Brasswick BOX 2/DISC3'];
      const r4 = await matchDiscs(lastGap.map((p) => ev(p)), ctx(fake({}), tmdb()));
      for (const p of lastGap.slice(1)) expect(byDisc(r4.matches, p)).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });

      const r2 = await matchDiscs([ev('TV/Brasswick BOX 2/DISC1')], ctx(fake({}), tmdb()));
      expect(byDisc(r2.matches, 'TV/Brasswick BOX 2/DISC1')).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });
    });

    it('I2: AniList seasons: OVAs have none, a Part 2 cour takes its place in the chain, a sequel without its prequel is unresolved', async () => {
      const s1 = entry('anilist:10', { english: 'Harbor Line' });
      const ova = entry('anilist:20', { english: 'Harbor Line OVA' }, { format: 'OVA' });
      const part2 = entry('anilist:21', { english: 'Harbor Line Part 2' }, { relations: [prequel('anilist:10')] });
      const orphan = entry('anilist:22', { english: 'Harbor Line 2nd Season' });
      const anilist = fake({ 'Harbor Line OVA': [ova], 'Harbor Line Part 2': [part2], 'Harbor Line': [orphan] }, [], [s1]);
      const paths = ['Anime/[BDMV] Harbor Line OVA Vol.1', 'Anime/[BDMV] Harbor Line Part 2 Vol.1', 'Anime/[BDMV] Harbor Line 2nd Season Vol.1'];
      const { matches } = await matchDiscs(paths.map((p) => ev(p)), ctx(anilist, null));
      expect(byDisc(matches, paths[0]!)).toMatchObject({ status: 'filed', entryId: 'anilist:20', season: null, disc: 1 });
      expect(byDisc(matches, paths[1]!)).toMatchObject({ status: 'filed', entryId: 'anilist:21', season: 2, disc: 1 });
      expect(byDisc(matches, paths[2]!)).toMatchObject({ status: 'unsorted', reason: 'no-season' });
    });

    it('I3: an entry whose year is more than 1 from the evidence\'s is not a fit', async () => {
      const tmdb = fake({ Brasswick: [entry('tmdb-movie:1', { english: 'Brasswick' }, { year: 1985 }), entry('tmdb-movie:2', { english: 'Brasswick' }, { year: 2019 })] });
      const { matches } = await matchDiscs([ev('Movies/Brasswick (2019)')], ctx(fake({}), tmdb));
      expect(byDisc(matches, 'Movies/Brasswick (2019)')).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:2' });

      const old = fake({ Brasswick: [entry('tmdb-movie:1', { english: 'Brasswick' }, { year: 1985 })] });
      const r2 = await matchDiscs([ev('Movies/Brasswick (2019)')], ctx(fake({}), old));
      expect(byDisc(r2.matches, 'Movies/Brasswick (2019)')).toMatchObject({ status: 'unsorted', reason: 'no-title' });
    });
  });

  describe('re-review scenarios (fix round 2)', () => {
    const prequel = (id: string): Entry['relations'][number] => ({ type: 'PREQUEL', id, format: 'TV', startDate: null });
    /** A source answering the same entries to every query. */
    const always = (es: Entry[], more: Entry[] = []): MetadataSource => ({
      search: async () => es,
      entry: async (id) => [...es, ...more].find((en) => en.id === id) ?? null,
    });

    it('N1: a disc title naming another entry disagrees even when the folder\'s year rules that entry out', async () => {
      const tmdb = fake({
        'Quiet Meadow': [entry('tmdb-movie:1', { english: 'Quiet Meadow' }, { year: 2019 })],
        'Lantern Coast': [entry('tmdb-movie:2', { english: 'Lantern Coast' }, { year: 1985 })],
      });
      const r1 = await matchDiscs([ev('Movies/Quiet Meadow (2019)', { eng: 'Lantern Coast' })], ctx(fake({}), tmdb));
      expect(byDisc(r1.matches, 'Movies/Quiet Meadow (2019)')).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });

      const tv = fake({
        Brasswick: [entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: seasons(3), year: 2019 })],
        'Lantern Coast': [entry('tmdb-tv:8', { english: 'Lantern Coast' }, { seasons: seasons(1), year: 2005 })],
      });
      const r2 = await matchDiscs([ev('TV/Brasswick (2019) S02/DISC2', { eng: 'Lantern Coast' })], ctx(fake({}), tv));
      expect(byDisc(r2.matches, 'TV/Brasswick (2019) S02/DISC2')).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });
    });

    it('N2/N3: AniList wins only when every same-titled TMDB fit is an animation twin', async () => {
      const anime = entry('anilist:200', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2019 });
      const twin = entry('tmdb-tv:201', { english: 'Glass Orchard' }, { year: 2019, seasons: seasons(1), animation: true });
      const drama = entry('tmdb-tv:203', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2020, seasons: seasons(1), animation: false });
      const unknown = entry('tmdb-tv:204', { english: 'Glass Orchard' }, { year: 2019, seasons: seasons(1), animation: null });
      const path = 'Shows/Glass Orchard/DISC1';
      const run = async (tmdb: MetadataSource | null, p = path, titles: Record<string, string> = {}) =>
        byDisc((await matchDiscs([ev(p, titles)], ctx(fake({ 'Glass Orchard': [anime], ガラスの果樹園: [anime] }), tmdb))).matches, p);

      expect(await run(fake({ 'Glass Orchard': [twin] }))).toMatchObject({ status: 'filed', entryId: 'anilist:200' });
      expect(await run(fake({ 'Glass Orchard': [twin, drama] }))).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run(fake({ 'Glass Orchard': [drama] }))).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run(fake({ 'Glass Orchard': [unknown] }))).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run(fake({ 'Glass Orchard': [{ ...twin, year: 1990 }] }))).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      // Japanese evidence asks TMDB too, and finds the live-action drama
      const jp = 'Drama/[BDMV] ガラスの果樹園 DISC1';
      const tmdb = fake({ ガラスの果樹園: [drama] });
      expect(await run(tmdb, jp, { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(tmdb.calls.length).toBeGreaterThan(0);
      // without a TMDB key AniList alone decides
      expect(await run(null)).toMatchObject({ status: 'filed', entryId: 'anilist:200' });
    });

    it('N4: more category folders are never candidates, and a folder two or more levels up is never the only evidence', async () => {
      const tmdb = fake({
        Film: [entry('tmdb-movie:91', { english: 'Film' }, { year: 1965 })],
        Drama: [entry('tmdb-movie:92', { english: 'Drama' })],
        Brasswick: [entry('tmdb-movie:93', { english: 'Brasswick' })],
      });
      const paths = ['Media/Film/BDROM', 'Video/Drama/Unknown Show/BDROM', 'Shelf/Brasswick/Extra/BDROM'];
      const { matches } = await matchDiscs(paths.map((p) => ev(p)), ctx(fake({}), tmdb));
      for (const p of paths) expect(byDisc(matches, p)).toMatchObject({ status: 'unsorted', reason: 'no-title' });

      const backed = 'Shelf/Brasswick/Extra/BDROM';
      const r2 = await matchDiscs([ev(backed, { eng: 'Brasswick' })], ctx(fake({}), tmdb));
      expect(byDisc(r2.matches, backed)).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:93', via: ['disc-title', 'folder'] });
    });

    it('N5: the category list applies to disc titles', async () => {
      const tmdb = fake({ Movies: [entry('tmdb-movie:94', { english: 'Movies' })] });
      const { matches } = await matchDiscs([ev('Movies/BDROM', { eng: 'Movies' })], ctx(fake({}), tmdb));
      expect(byDisc(matches, 'Movies/BDROM')).toMatchObject({ status: 'unsorted', reason: 'no-title' });
    });

    it('N6: an evidence season that is neither the chain position nor in the entry\'s name is no-season', async () => {
      const s1 = entry('anilist:10', { english: 'Harbor Line' });
      const tides = entry('anilist:11', { english: 'Harbor Line Tides' }, { relations: [prequel('anilist:10')] });
      const path = 'Anime/[BDMV] Harbor Line Tides Season 3 Vol.1';
      const { matches } = await matchDiscs([ev(path)], ctx(fake({ 'Harbor Line Tides': [tides] }, [], [s1]), null));
      expect(byDisc(matches, path)).toMatchObject({ status: 'unsorted', reason: 'no-season' });
    });

    it('N7: titles that differ only in a significant mark are different', async () => {
      const glimmer = entry('anilist:50', { romaji: 'Glimmer' });
      const path = "Anime/[BDMV] Glimmer' Vol.1";
      const { matches } = await matchDiscs([ev(path)], ctx(fake({ "Glimmer'": [glimmer] }), null));
      const m = byDisc(matches, path);
      expect(m.status === 'filed' && m.entryId === 'anilist:50').toBe(false);
    });

    it('N8: a TV entry whose name carries a sequel marker but has no prequel is no-season', async () => {
      const marked = ['Harbor Line Final Season', 'Harbor Line 2nd Cour', 'Harbor Line Cour 2', 'Zoku Harbor Line', 'Harbor Line Part 3', '港線 第2クール', '港線 完結編', '続・港線'];
      for (const [i, name] of marked.entries()) {
        const en = entry(`anilist:${600 + i}`, { english: name });
        const path = `Anime/[BDMV] ${name} Vol.1`;
        const { matches } = await matchDiscs([ev(path)], ctx(always([en]), null));
        expect(byDisc(matches, path), name).toMatchObject({ status: 'unsorted', reason: 'no-season' });
      }
    });
  });

  describe('twin rules (fix round 3)', () => {
    const prequel = (id: string): Entry['relations'][number] => ({ type: 'PREQUEL', id, format: 'TV', startDate: null });

    it('T5q: a TMDB series dated from the chain root is the twin of a later AniList season', async () => {
      const s1 = entry('anilist:801', { english: 'Harbor Line' }, { year: 2019 });
      const s2 = entry('anilist:802', { english: 'Harbor Line Season 2' }, { year: 2021, relations: [prequel('anilist:801')] });
      const s3 = entry('anilist:803', { english: 'Harbor Line Season 3' }, { year: 2023, relations: [prequel('anilist:802')] });
      const path = 'Shows/[BDMV] Harbor Line Season 3 Vol.1';
      const run = async (t: Entry) => byDisc((await matchDiscs([ev(path)], ctx(fake({ 'Harbor Line': [s3] }, [], [s1, s2]), fake({ 'Harbor Line': [t] })))).matches, path);
      const series = entry('tmdb-tv:810', { english: 'Harbor Line' }, { year: 2019, seasons: seasons(3), animation: true });
      expect(await run(series)).toMatchObject({ status: 'filed', entryId: 'anilist:803', season: 3, disc: 1 });
      expect(await run({ ...series, animation: false })).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      // before the chain root's year minus one: not the same series
      expect(await run({ ...series, year: 2016 })).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
    });

    it('T5r: a live-action TMDB entry named like the AniList entry, but not like the evidence, is several-fit (G4)', async () => {
      const anime = entry('anilist:200', { english: 'Glass Orchard', romaji: 'Garasu no Kajuen', native: 'ガラスの果樹園' }, { year: 2019 });
      const path = 'Drama/[BDMV] ガラスの果樹園 DISC1';
      for (const names of [{ english: 'Glass Orchard' }, { english: 'Garasu no Kajuen' }]) {
        const drama = entry('tmdb-tv:203', names, { year: 2020, seasons: seasons(1), animation: false });
        const { matches } = await matchDiscs([ev(path, { jpn: 'ガラスの果樹園' })], ctx(fake({ ガラスの果樹園: [anime] }), fake({ ガラスの果樹園: [drama] })));
        expect(byDisc(matches, path), names.english).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      }
    });
  });

  describe('single twin (fix round 4)', () => {
    const prequel = (id: string): Entry['relations'][number] => ({ type: 'PREQUEL', id, format: 'TV', startDate: null });
    const s1 = entry('anilist:801', { english: 'Harbor Line' }, { year: 2019 });
    const s2 = entry('anilist:802', { english: 'Harbor Line Season 2' }, { year: 2021, relations: [prequel('anilist:801')] });
    const s3 = entry('anilist:803', { english: 'Harbor Line Season 3' }, { year: 2023, relations: [prequel('anilist:802')] });
    const path = 'Shows/[BDMV] Harbor Line Season 3 Vol.1';
    const series = (id: string, year: number, n: number) => entry(id, { english: 'Harbor Line' }, { year, seasons: seasons(n), animation: true });
    const run = async (found: Entry[], more: Entry[] = []) =>
      byDisc((await matchDiscs([ev(path)], ctx(fake({ 'Harbor Line': [s3] }, [], [s1, s2]), fake({ 'Harbor Line': found }, [], more)))).matches, path);

    it('T5s: two animated TMDB series that both qualify as twins of an AniList season are several-fit (R1)', async () => {
      const m = await run([series('tmdb-tv:810', 2019, 3), series('tmdb-tv:819', 2022, 3)]);
      expect(m).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(m.status === 'unsorted' && [...m.suggestions].sort()).toEqual(['anilist:803', 'tmdb-tv:810', 'tmdb-tv:819']);
    });

    it('T5s: two animated TMDB entries that both qualify as twins of an AniList first season are several-fit (R3)', async () => {
      const anime = entry('anilist:200', { english: 'Glass Orchard' }, { year: 2019 });
      const tv = (id: string, year: number) => entry(id, { english: 'Glass Orchard' }, { year, seasons: seasons(1), animation: true });
      const p = 'Anime/Glass Orchard/DISC1';
      const { matches } = await matchDiscs([ev(p)], ctx(fake({ 'Glass Orchard': [anime] }), fake({ 'Glass Orchard': [tv('tmdb-tv:201', 2019), tv('tmdb-tv:209', 2020)] })));
      const m = byDisc(matches, p);
      expect(m).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(m.status === 'unsorted' && [...m.suggestions].sort()).toEqual(['anilist:200', 'tmdb-tv:201', 'tmdb-tv:209']);
    });

    it('T5t: a TMDB series with fewer seasons than the AniList chain position is not its twin (R2)', async () => {
      expect(await run([series('tmdb-tv:819', 2022, 1)])).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run([series('tmdb-tv:819', 2022, 4)])).toMatchObject({ status: 'filed', entryId: 'anilist:803', season: 3, disc: 1 });
    });

    it('T5t: seasons missing from the search result are fetched; still unknown, a base-name match is not a twin', async () => {
      const bare = series('tmdb-tv:819', 2022, 0);
      expect(await run([bare])).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run([bare], [series('tmdb-tv:819', 2022, 4)])).toMatchObject({ status: 'filed', entryId: 'anilist:803', season: 3 });
    });
  });

  describe('final review', () => {
    /** Evidence as production makes it: the root's name isn't a segment. */
    const rooted = (path: string, titles: Record<string, string> = {}): DiscEvidence => ({ ...ev(path, titles), segments: path.split('/').slice(1) });

    it('I1: a TMDB series found by search (no seasons) is fetched by id once, and files by its seasons', async () => {
      const orchard = entry('tmdb-tv:300', { english: 'Glass Orchard' }, { seasons: seasons(3) });
      const tmdb = fake({ 'Glass Orchard': [orchard] });
      const entryCalls: string[] = [];
      const counting: MetadataSource = { search: (q, o) => tmdb.search(q, o), entry: async (id) => { entryCalls.push(id); return tmdb.entry(id); } };
      const path = 'TV/Glass Orchard Season 2 Disc 1';
      const second = 'TV/Glass Orchard Season 2 Disc 2';
      const c = ctx(fake({}), counting);
      const { matches, entries } = await matchDiscs([ev(path), ev(second)], c);
      expect(byDisc(matches, path)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:300', season: 2, disc: 1 });
      expect(byDisc(matches, second)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:300', season: 2, disc: 2 });
      // the catalogue gets the full entry, with its seasons
      expect(entries.get('tmdb-tv:300')!.seasons).toHaveLength(3);
      expect(entryCalls).toEqual(['tmdb-tv:300']);
      expect(c.cache.get('tmdb-entry:tmdb-tv:300')).toEqual([orchard]);
    });

    it('I1: a TheDiscDB hit on a TMDB TV set files under its season', async () => {
      const tmdb = fake({ 'Glass Orchard': [entry('tmdb-tv:300', { english: 'Glass Orchard' }, { seasons: seasons(3) })] });
      const hit: DiscDbHit = { title: 'Glass Orchard', year: null, kind: 'series', tmdbId: '300', season: 2, episodes: [] };
      const path = 'TV/Glass Orchard/GLASS_ORCHARD_S2_D1';
      const { matches } = await matchDiscs([ev(path, {}, 'FP2')], ctx(fake({}), tmdb, { FP2: hit }));
      expect(byDisc(matches, path)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:300', season: 2 });
    });

    it("I6: a root's top-level folder is evidence, alone too, but category names still aren't", async () => {
      const starfall = entry('anilist:900', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { episodes: 12 });
      const anilist = fake({ 'Starfall Wanderer': [starfall], 星降りの旅人: [starfall], Anime: [entry('anilist:901', { english: 'Anime' })] });
      const tidy = 'drv0/Starfall Wanderer (星降りの旅人)/Volume 2';
      const shelf = 'drv0/Anime/BDROM';
      const { matches } = await matchDiscs([rooted(tidy), rooted(shelf)], ctx(anilist, null));
      expect(byDisc(matches, tidy)).toMatchObject({ status: 'filed', entryId: 'anilist:900', season: 1, disc: 2, via: ['folder'] });
      expect(byDisc(matches, shelf)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
    });

    it("F6: a top-level folder is the only evidence only as the disc folder's parent; two levels up it only supports", async () => {
      const tmdb = fake({ Brasswick: [entry('tmdb-movie:93', { english: 'Brasswick' })] });
      const parent = 'drv0/Brasswick/BDROM';
      const top = 'drv0/Brasswick/Extra/BDROM';
      const below = 'drv0/Shelf/Brasswick/Extra/BDROM';
      const { matches } = await matchDiscs([rooted(parent), rooted(top), rooted(below)], ctx(fake({}), tmdb));
      expect(byDisc(matches, parent)).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:93' });
      expect(byDisc(matches, top)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
      expect(byDisc(matches, below)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
      // two levels up, it still supports the disc's own evidence
      const backed = 'drv0/Brasswick/Extra/Brasswick';
      const r = await matchDiscs([rooted(backed)], ctx(fake({}), tmdb));
      expect(byDisc(r.matches, backed)).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:93' });
    });

    it('F6: an organising top-level folder named like a title never files the discs two levels below it', async () => {
      const tmdb = fake({ Watched: [entry('tmdb-movie:1', { english: 'Watched' })] });
      const paths = ['drv0/Watched/Unknown Series/Unknown Series Vol.1', 'drv0/Watched/Some Unknown Thing/BDROM'];
      const { matches } = await matchDiscs(paths.map((p) => rooted(p)), ctx(fake({}), tmdb));
      for (const p of paths) expect(byDisc(matches, p)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
    });

    it('F7: a checkpoint publishes box 2 and up as Unsorted until every group of its box family is matched', async () => {
      const tmdb = (): MetadataSource => fake({ Brasswick: [entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: seasons(1) })] });
      const run = async (paths: readonly string[]): Promise<{ checkpoints: DiscMatch[][]; final: DiscMatch[] }> => {
        const checkpoints: DiscMatch[][] = [];
        const c: MatchContext = { ...ctx(fake({}), tmdb()), onGroupDone: (progress) => { checkpoints.push(progress().matches); } };
        return { checkpoints, final: (await matchDiscs(paths.map((p) => ev(p)), c)).matches };
      };
      const box2 = 'TV/Brasswick BOX 2/DISC1';
      const state = (ms: readonly DiscMatch[], path: string): unknown => {
        const m = ms.find((x) => x.discId === `id:${path}`);
        return m?.status === 'filed' ? m.disc : m?.status === 'unsorted' ? m.reason : m?.status;
      };
      // box 3 has a gap, which the final pass sees: box 2 never shows as filed on the way
      const gap = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 1/DISC2', box2, 'TV/Brasswick BOX 3/DISC1', 'TV/Brasswick BOX 3/DISC3'];
      const r1 = await run(gap);
      expect(state(r1.final, box2)).toBe('no-disc-number');
      expect(r1.checkpoints).toHaveLength(3);
      for (const cp of r1.checkpoints) if (cp.some((m) => m.discId === `id:${box2}`)) expect(state(cp, box2)).toBe('no-disc-number');
      // box 1 needs no other box, so it files at once
      expect(state(r1.checkpoints[0]!, 'TV/Brasswick BOX 1/DISC2')).toBe(2);
      // a whole family without a gap: Unsorted at the checkpoint before box 3, filed once every box is matched
      const whole = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 1/DISC2', box2, 'TV/Brasswick BOX 3/DISC1'];
      const r2 = await run(whole);
      expect(state(r2.checkpoints[1]!, box2)).toBe('no-disc-number');
      expect(state(r2.checkpoints[2]!, box2)).toBe(3);
      expect(state(r2.final, box2)).toBe(3);
    });

    it('M2: spellings that differ only in vowels are each searched', async () => {
      const anilist = fake({});
      await matchDiscs([ev('Anime/Good Hunter/BDROM'), ev('Anime2/God Hunter/BDROM')], ctx(anilist, null));
      expect(anilist.calls.filter((q) => q === normalizeTitle('Good Hunter'))).toHaveLength(2);
    });

    it('M3: five groups failing in a row stop the run; the rest are not looked up', async () => {
      const names = ['Alpha Reel', 'Bravo Reel', 'Charlie Reel', 'Delta Reel', 'Echo Reel', 'Foxtrot Reel', 'Golf Reel'];
      const anilist = fake({}, names);
      const discs = names.map((n, i) => ev(`Anime${i}/${n}/BDROM`));
      const r = await matchDiscs(discs, ctx(anilist, null));
      expect(r.aborted).toBe(true);
      expect(new Set(anilist.calls).size).toBe(5);
      for (const m of r.matches) expect(m).toMatchObject({ status: 'unsorted', reason: 'source-unreachable' });

      // a success in between resets the count
      const some = fake({ 'Charlie Reel': [entry('anilist:3', { english: 'Charlie Reel' })] }, names.filter((n) => n !== 'Charlie Reel'));
      const r2 = await matchDiscs(discs, ctx(some, null));
      expect(r2.aborted).toBe(false);
    });

    it("I2: an Unsorted disc carries the matcher's season for each suggestion it resolved", async () => {
      const s1 = entry('anilist:10', { english: 'Harbor Line' });
      const s2 = entry('anilist:11', { english: 'Harbor Line 2nd Season' }, { relations: [{ type: 'PREQUEL', id: 'anilist:10', format: 'TV', startDate: null }] });
      const anilist = fake({ 'Harbor Line': [s2] }, [], [s1]);
      const discs = ['A', 'B'].map((l) => ev(`Anime/[BDMV] Harbor Line 2nd Season/HARBOR_${l}`));
      const { matches } = await matchDiscs(discs, ctx(anilist, null));
      for (const m of matches) expect(m).toMatchObject({ status: 'unsorted', reason: 'no-disc-number', suggestions: ['anilist:11'], seasons: { 'anilist:11': 2 } });
    });
  });

  describe('tuning after the first real run', () => {
    /** Evidence as production makes it: the root's name isn't a segment. */
    const rooted = (path: string, titles: Record<string, string> = {}): DiscEvidence => ({ ...ev(path, titles), segments: path.split('/').slice(1) });
    const related = (type: string, id: string, format: string | null = 'TV'): Entry['relations'][number] => ({ type, id, format, startDate: null });
    const run = async (paths: readonly string[], anilist: MetadataSource, tmdb: MetadataSource | null): Promise<DiscMatch[]> =>
      (await matchDiscs(paths.map((p) => rooted(p)), ctx(anilist, tmdb))).matches;
    const starfall = entry('anilist:900', { romaji: 'Hoshifuri no Tabibito', native: '星降りの旅人' }, { episodes: 12, year: 2021 });
    const starfallEn = entry('anilist:900', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { episodes: 12, year: 2021 });

    describe('M1: structure-only folders are not levels', () => {
      it('files a disc under Title (日本語)/Season 1/Volume 1 and Title/Volume 1/Disc 3', async () => {
        const anilist = fake({ 'Starfall Wanderer': [starfallEn], 星降りの旅人: [starfallEn] });
        const season = 'drv0/Starfall Wanderer (星降りの旅人)/Season 1/Volume 1';
        const disc = 'drv0/Starfall Wanderer/Volume 1/Disc 3';
        const deep = 'drv0/Starfall Wanderer (星降りの旅人)/Season 1/Volume 2/Disc 1';
        const ms = await run([season, disc], anilist, null);
        expect(byDisc(ms, season)).toMatchObject({ status: 'filed', entryId: 'anilist:900', season: 1, disc: 1, via: ['folder'] });
        expect(byDisc(ms, disc)).toMatchObject({ status: 'filed', entryId: 'anilist:900', season: 1, disc: 3, via: ['folder'] });
        // Season N/Volume M/Disc K puts the title three folders up: still found, and Volume 2 waits for Volume 1
        expect(byDisc(await run([deep], anilist, null), deep)).toMatchObject({ status: 'unsorted', reason: 'no-disc-number', suggestions: ['anilist:900'] });
        for (const label of ['Box 1', 'Vol.1', 'BD', 'BDROM', 'DISC_2']) {
          const p = `drv0/Starfall Wanderer/${label}/Disc 1`;
          expect(byDisc(await run([p], anilist, null), p), label).toMatchObject({ status: 'filed', entryId: 'anilist:900' });
        }
      });

      it('W3: discs of two group folders numbered differently into one slot both go to no-disc-number; copies stay', async () => {
        const quill = entry('anilist:995', { english: 'Quill Harbor' }, { year: 2015 });
        const b = 'drv0/Anime/Quill Harbor';
        const state = (ms: readonly DiscMatch[], p: string): unknown => { const m = byDisc(ms, p); return m.status === 'filed' ? m.disc : m.status === 'unsorted' ? m.reason : m.status; };
        const mixed = [`${b}/Volume 1/Disc 1`, `${b}/Volume 1/Disc 2`, `${b}/Volume 2`];
        const r1 = await run(mixed, fake({ 'Quill Harbor': [quill] }), null);
        expect(mixed.map((p) => state(r1, p))).toEqual([1, 'no-disc-number', 'no-disc-number']);
        const three = [`${b}/Volume 1/Disc 1`, `${b}/Volume 2/Disc 1`, `${b}/Volume 2/Disc 2`, `${b}/Volume 3`];
        const r2 = await run(three, fake({ 'Quill Harbor': [quill] }), null);
        expect(three.map((p) => state(r2, p))).toEqual([1, 2, 'no-disc-number', 'no-disc-number']);
        // the same disc in two places (equal content) is two copies of one disc, as before
        const copies = ['drv0/Anime/Quill Harbor/Volume 1', 'drv1/Backup/Quill Harbor/Volume 1'];
        const r3 = await matchDiscs(copies.map((p) => ({ ...rooted(p), fingerprint: 'FPQ1' })), ctx(fake({ 'Quill Harbor': [quill] }), null));
        for (const p of copies) expect(byDisc(r3.matches, p)).toMatchObject({ status: 'filed', entryId: 'anilist:995', disc: 1 });
        // and one layout on two roots, numbered the same way, is copies too, even without fingerprints
        const twice = ['drv0', 'drv1'].flatMap((root) => [1, 2].map((d) => `${root}/Anime/Quill Harbor/Volume 1/Disc ${d}`));
        const r4 = await run(twice, fake({ 'Quill Harbor': [quill] }), null);
        expect(twice.map((p) => state(r4, p))).toEqual([1, 2, 1, 2]);
      });

      it('numbers Volume M/Disc K discs across the volumes, like boxes, so two volumes never share a slot', async () => {
        const anilist = fake({ 'Starfall Wanderer': [starfallEn] });
        const paths = ['drv0/Starfall Wanderer/Volume 1/Disc 1', 'drv0/Starfall Wanderer/Volume 1/Disc 2', 'drv0/Starfall Wanderer/Volume 2/Disc 1'];
        const ms = await run(paths, anilist, null);
        expect(paths.map((p) => { const m = byDisc(ms, p); return m.status === 'filed' ? m.disc : m.status; })).toEqual([1, 2, 3]);
        const gap = await run(paths.slice(1), anilist, null);
        expect(byDisc(gap, paths[2]!)).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });
      });

      it('still counts a folder with a title candidate, and category folders still name nothing', async () => {
        const tmdb = fake({ Watched: [entry('tmdb-movie:1', { english: 'Watched' })] });
        const paths = ['drv0/Watched/Unknown Series/Unknown Series Vol.1', 'drv0/Watched/Unknown Series/Volume 1', 'drv0/Watched/Extra/Volume 1/Disc 1'];
        const ms = await run(paths, fake({}), tmdb);
        for (const p of paths) expect(byDisc(ms, p), p).toMatchObject({ status: 'unsorted', reason: 'no-title' });
        const anime = fake({ Anime: [entry('anilist:901', { english: 'Anime' })], Movies: [entry('anilist:902', { english: 'Movies' })] });
        const shelves = ['drv0/Anime/Season 1/Volume 1', 'drv0/Movies/Disc 2', 'drv0/Anime/Volume 1/Disc 1'];
        const ms2 = await run(shelves, anime, null);
        for (const p of shelves) expect(byDisc(ms2, p), p).toMatchObject({ status: 'unsorted', reason: 'no-title' });
      });
    });

    describe('M2: twin names', () => {
      const vols = (title: string, n = 2): string[] => Array.from({ length: n }, (_, i) => `drv0/${title}/Volume ${i + 1}`);

      it('an AniList entry fitting one half of English (日本語) and an animated TMDB entry fitting the other are twins', async () => {
        const anilist = fake({ 星降りの旅人: [starfall] });
        const tv = entry('tmdb-tv:910', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { year: 2021, seasons: seasons(1), animation: true });
        const paths = vols('Starfall Wanderer (星降りの旅人)');
        const ms = await run(paths, anilist, fake({ 'Starfall Wanderer': [tv] }));
        paths.forEach((p, i) => expect(byDisc(ms, p)).toMatchObject({ status: 'filed', entryId: 'anilist:900', season: 1, disc: i + 1 }));
        // the Japanese half fits as fully as the English one, so with no TMDB key AniList alone files
        const alone = await run(paths, anilist, null);
        for (const p of paths) expect(byDisc(alone, p)).toMatchObject({ status: 'filed', entryId: 'anilist:900' });
        // a note in parens is no half: it fits only partly
        const note = 'drv0/Starfall Wanderer (Collector Edition)/Volume 1';
        const cut = await run([note], fake({ 'Collector Edition': [entry('anilist:905', { english: 'Collector Edition' })] }), null);
        expect(byDisc(cut, note)).toMatchObject({ status: 'unsorted' });
        // live action: still several-fit
        const drama = await run(paths, anilist, fake({ 'Starfall Wanderer': [{ ...tv, animation: false }] }));
        for (const p of paths) expect(byDisc(drama, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        // outside the year window: still several-fit
        const old = await run(paths, anilist, fake({ 'Starfall Wanderer': [{ ...tv, year: 2005 }] }));
        for (const p of paths) expect(byDisc(old, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });

      it('a same-segment twin of a later AniList season needs as many TMDB seasons as its place (T5t)', async () => {
        const s1 = entry('anilist:920', { romaji: 'Hoshifuri no Tabibito', native: '星降りの旅人' }, { year: 2021 });
        const s2 = entry('anilist:921', { romaji: 'Hoshifuri no Tabibito 2nd Season', native: '星降りの旅人 第2期' }, { year: 2023, relations: [related('PREQUEL', 'anilist:920')] });
        const anilist = fake({ 星降りの旅人: [s2] }, [], [s1]);
        const p = 'drv0/Starfall Wanderer (星降りの旅人)/Season 2/Volume 1';
        const tv = (n: number) => fake({ 'Starfall Wanderer': [entry('tmdb-tv:930', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { year: 2021, seasons: seasons(n), animation: true })] });
        expect(byDisc(await run([p], anilist, tv(2)), p)).toMatchObject({ status: 'filed', entryId: 'anilist:921', season: 2, disc: 1 });
        expect(byDisc(await run([p], anilist, tv(1)), p)).toMatchObject({ status: 'unsorted' });
      });

      it('M2b: a segment twin needs TMDB to carry the Japanese name too', async () => {
        const moon = entry('anilist:906', { english: 'Moonlit Garden', native: '月影の庭' }, { year: 2021 });
        const star = entry('tmdb-tv:907', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { year: 2021, seasons: seasons(1), animation: true });
        const paths = vols('Starfall Wanderer (月影の庭)');
        // TMDB's own Japanese name shows it is another work; with none, nothing ties the halves together
        for (const t of [star, { ...star, names: { ...star.names, native: null } }]) {
          const ms = await run(paths, fake({ 月影の庭: [moon] }), fake({ 'Starfall Wanderer': [t] }));
          for (const p of paths) expect(byDisc(ms, p), String(t.names.native)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
        // a synonym in Japanese that names the folder's half is enough
        const named = { ...star, names: { ...star.names, native: null, synonyms: ['月影の庭'] } };
        const ok = await run(paths, fake({ 月影の庭: [moon] }), fake({ 'Starfall Wanderer': [named] }));
        for (const p of paths) expect(byDisc(ok, p)).toMatchObject({ status: 'filed', entryId: 'anilist:906' });
      });

      it("names that differ only by ’ and ' or & and and are one name, so the entries are twins", async () => {
        const apos = entry('anilist:940', { english: 'Harbor’s Light' }, { year: 2018 });
        const aposTv = entry('tmdb-tv:941', { english: "Harbor's Light" }, { year: 2018, seasons: seasons(1), animation: true });
        const p1 = "drv0/Harbor's Light/Volume 1";
        const r1 = await run([p1], fake({ "Harbor's Light": [apos] }), fake({ "Harbor's Light": [aposTv] }));
        expect(byDisc(r1, p1)).toMatchObject({ status: 'filed', entryId: 'anilist:940', disc: 1 });

        const amp = entry('anilist:950', { english: 'Fin & Feather' }, { year: 2020 });
        const ampTv = entry('tmdb-tv:951', { english: 'Fin and Feather' }, { year: 2020, seasons: seasons(1), animation: true });
        const p2 = 'drv0/Fin and Feather/Volume 1';
        const r2 = await run([p2], fake({ 'Fin and Feather': [amp] }), fake({ 'Fin and Feather': [ampTv] }));
        expect(byDisc(r2, p2)).toMatchObject({ status: 'filed', entryId: 'anilist:950', disc: 1 });
        const r3 = await run([p2], fake({ 'Fin and Feather': [amp] }), fake({ 'Fin and Feather': [{ ...ampTv, animation: false }] }));
        expect(byDisc(r3, p2)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });
    });

    describe('M3: series-shaped evidence', () => {
      const orchard = entry('anilist:960', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2019, episodes: 12 });
      const film = entry('tmdb-movie:961', { english: 'Glass Orchard' }, { year: 2019, animation: false });
      const vols = ['drv0/Glass Orchard/Volume 1', 'drv0/Glass Orchard/Volume 2'];

      it('a same-named TMDB movie, live action or of another year, does not block a series volume set', async () => {
        for (const t of [film, { ...film, year: 2008 }, { ...film, animation: true, year: 2004 }]) {
          const ms = await run(vols, fake({ 'Glass Orchard': [orchard] }), fake({ 'Glass Orchard': [t] }));
          vols.forEach((p, i) => expect(byDisc(ms, p), `${t.year}`).toMatchObject({ status: 'filed', entryId: 'anilist:960', season: 1, disc: i + 1 }));
        }
        // a season number or an episode range is series-shaped on its own
        for (const p of ['drv0/Glass Orchard/Season 1/Volume 1', 'drv0/Glass Orchard (01-06)/Volume 1']) {
          const ms = await run([p], fake({ 'Glass Orchard': [orchard] }), fake({ 'Glass Orchard': [film] }));
          expect(byDisc(ms, p), p).toMatchObject({ status: 'filed', entryId: 'anilist:960' });
        }
        // an AniList MOVIE is no competitor either
        const anilistFilm = entry('anilist:962', { english: 'Glass Orchard' }, { year: 2019, format: 'MOVIE', kind: 'movie' });
        const ms = await run(vols, fake({ 'Glass Orchard': [orchard, anilistFilm] }), null);
        for (const p of vols) expect(byDisc(ms, p)).toMatchObject({ status: 'filed', entryId: 'anilist:960' });
      });

      it('a lone disc without a volume number, or a lone volume, is not series-shaped: movie and series is several-fit', async () => {
        for (const p of ['drv0/Glass Orchard/BDROM', 'drv0/Glass Orchard/Volume 1']) {
          const ms = await run([p], fake({ 'Glass Orchard': [orchard] }), fake({ 'Glass Orchard': [film] }));
          expect(byDisc(ms, p), p).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
      });

      it('W1: films whose names carry a volume still compete with a series', async () => {
        const tmdb = fake({
          'Blade Night': [
            entry('tmdb-movie:992', { english: 'Blade Night: Vol. 1' }, { year: 2003 }),
            entry('tmdb-movie:993', { english: 'Blade Night: Vol. 2' }, { year: 2004 }),
            entry('tmdb-tv:994', { english: 'Blade Night' }, { year: 2010, seasons: seasons(1) }),
          ],
        });
        const paths = ['drv0/Movies/Blade Night/Blade Night Vol. 1', 'drv0/Movies/Blade Night/Blade Night Vol. 2'];
        const ms = await run(paths, fake({}), tmdb);
        for (const p of paths) expect(byDisc(ms, p)).toMatchObject({ status: 'unsorted' });
        for (const p of paths) expect(byDisc(ms, p).status === 'unsorted' && (byDisc(ms, p) as { suggestions: readonly string[] }).suggestions).toContain('tmdb-tv:994');
      });

      it('M3b: disc numbers alone are not series-shaped; volume numbers among siblings are', async () => {
        const tmdb = (): MetadataSource => fake({ 'Quiet Meadow': [
          entry('tmdb-tv:990', { english: 'Quiet Meadow' }, { year: 2015, seasons: seasons(1) }),
          entry('tmdb-movie:991', { english: 'Quiet Meadow' }, { year: 2015 }),
        ] });
        for (const pair of [['DISC1', 'DISC2'], ['D1', 'D2'], ['Disc 1', 'Disc 2']]) {
          const paths = pair.map((d) => `drv0/Quiet Meadow/${d}`);
          const ms = await run(paths, fake({}), tmdb());
          for (const p of paths) expect(byDisc(ms, p), p).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
        const paths = ['drv0/Quiet Meadow/Volume 1', 'drv0/Quiet Meadow/Volume 2'];
        const ms = await run(paths, fake({}), tmdb());
        paths.forEach((p, i) => expect(byDisc(ms, p)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:990', season: 1, disc: i + 1 }));
      });

      it('an AniList TV entry beats its own related OVA, ONA, SPECIAL and TV_SHORT entries', async () => {
        const tv = entry('anilist:970', { english: 'Harbor Line', native: '港線' }, { year: 2019, relations: [related('SIDE_STORY', 'anilist:971', 'SPECIAL'), related('ALTERNATIVE', 'anilist:974', 'OVA')] });
        const specials = entry('anilist:971', { english: 'Harbor Line Specials', native: '港線' }, { format: 'SPECIAL', year: 2020, relations: [related('PARENT', 'anilist:970')] });
        const mini = entry('anilist:972', { english: 'Harbor Line Mini', synonyms: ['Harbor Line'] }, { format: 'TV_SHORT', year: 2020, relations: [related('PARENT', 'anilist:970')] });
        const ona = entry('anilist:973', { english: 'Harbor Line Short', native: '港線' }, { format: 'ONA', year: 2021, relations: [] });
        const ova = entry('anilist:975', { english: 'Harbor Line', native: '港線' }, { format: 'OVA', year: 2019, relations: [related('SEQUEL', 'anilist:970')] });
        const onaLinked = { ...ona, relations: [related('PREQUEL', 'anilist:970')] };
        const paths = ['drv0/Harbor Line (港線)/Volume 1', 'drv0/Harbor Line (港線)/Volume 2'];
        const all = [tv, specials, mini, onaLinked, ova];
        const ms = await run(paths, fake({ 'Harbor Line': all, 港線: all }), null);
        paths.forEach((p, i) => expect(byDisc(ms, p)).toMatchObject({ status: 'filed', entryId: 'anilist:970', season: 1, disc: i + 1 }));
        // an unrelated OVA of the same name (ALTERNATIVE isn't a story link, nor is no link at all): several-fit
        for (const other of [ona, entry('anilist:974', { english: 'Harbor Line', native: '港線' }, { format: 'OVA', year: 2019 })]) {
          const r = await run(paths, fake({ 'Harbor Line': [tv, other], 港線: [tv, other] }), null);
          for (const p of paths) expect(byDisc(r, p), other.id).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
        // two TV entries: several-fit
        const remake = entry('anilist:976', { english: 'Harbor Line', native: '港線' }, { year: 2024, relations: [related('SIDE_STORY', 'anilist:970')] });
        const r2 = await run(paths, fake({ 'Harbor Line': [tv, remake], 港線: [tv, remake] }), null);
        for (const p of paths) expect(byDisc(r2, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        // not series-shaped: the side entries still compete
        const lone = 'drv0/Harbor Line (港線)/BDROM';
        expect(byDisc(await run([lone], fake({ 'Harbor Line': [tv, specials], 港線: [tv, specials] }), null), lone)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });

      it('keeps anime and live-action series of one name, and AniList seasons 1 and 2 without a season number, several-fit', async () => {
        const drama = entry('tmdb-tv:963', { english: 'Glass Orchard' }, { year: 2020, seasons: seasons(1), animation: false });
        const r1 = await run(vols, fake({ 'Glass Orchard': [orchard] }), fake({ 'Glass Orchard': [drama] }));
        for (const p of vols) expect(byDisc(r1, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        const s2 = entry('anilist:964', { english: 'Glass Orchard 2nd Season' }, { year: 2021, relations: [related('PREQUEL', 'anilist:960')] });
        const r2 = await run(vols, fake({ 'Glass Orchard': [orchard, s2] }), null);
        for (const p of vols) expect(byDisc(r2, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });
    });

    describe('M4: specials as films', () => {
      const tale = (format: string, more: Partial<Entry> = {}) =>
        entry('anilist:980', { english: 'Glass Orchard: Winter Tale' }, { format, kind: format === 'MOVIE' ? 'movie' : 'series', year: 2020, ...more });
      const film = entry('tmdb-movie:981', { english: 'Glass Orchard Winter Tale' }, { year: 2021, animation: true });
      const p = 'drv0/Glass Orchard Winter Tale';

      it('an AniList MOVIE, SPECIAL or OVA and an animated TMDB movie of one name and year are one work: AniList wins', async () => {
        for (const format of ['MOVIE', 'SPECIAL', 'OVA']) {
          const ms = await run([p], fake({ 'Glass Orchard Winter Tale': [tale(format)] }), fake({ 'Glass Orchard Winter Tale': [film] }));
          expect(byDisc(ms, p), format).toMatchObject({ status: 'filed', entryId: 'anilist:980', season: null, disc: null });
        }
      });

      it('not when the TMDB movie is live action, two years off, or named differently', async () => {
        for (const t of [{ ...film, animation: false }, { ...film, year: 2022 }, { ...film, animation: null }]) {
          const ms = await run([p], fake({ 'Glass Orchard Winter Tale': [tale('SPECIAL')] }), fake({ 'Glass Orchard Winter Tale': [t] }));
          expect(byDisc(ms, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
        // the TV entry and a TMDB movie of the same name are not twins
        const ms = await run([p], fake({ 'Glass Orchard Winter Tale': [tale('TV')] }), fake({ 'Glass Orchard Winter Tale': [film] }));
        expect(byDisc(ms, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });
    });
  });
});
