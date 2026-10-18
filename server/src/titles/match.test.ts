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

/** A source answering fixed entries per normalised query, recording every call. */
function fake(results: Record<string, Entry[]>, fail: readonly string[] = [], more: readonly Entry[] = []): MetadataSource & { calls: string[] } {
  const byKey = new Map(Object.entries(results).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map([...Object.values(results).flat(), ...more].map((en) => [en.id, en]));
  const calls: string[] = [];
  return {
    calls,
    async search(query) {
      calls.push(normalizeTitle(query));
      if (fail.some((f) => normalizeTitle(f) === normalizeTitle(query))) throw new SourceUnavailable('down');
      return byKey.get(normalizeTitle(query)) ?? [];
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
});
