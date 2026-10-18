import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTitle } from '../../../src/engine/disc/title-text';
import { ArtCache } from './art';
import type { DiscEvidence } from './evidence';
import { OwnerStore } from './owner-store';
import { downloadRootNames, fixtureSources, loadDiscDbOrNone, TitleService } from './service';
import { SourceUnavailable } from './sources';
import type { Entry, EntryNames, MetadataSource } from './sources';

// Every title and path here is made up (ruling R4).

const DAY = 86_400_000;

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

/** A source answering fixed entries per normalised query and by id, counting calls; `down` makes every call throw. */
function fake(results: Record<string, Entry[]>, more: readonly Entry[] = []): MetadataSource & { calls: string[]; down: boolean; failIds: Set<string>; byId: Map<string, Entry> } {
  const byKey = new Map(Object.entries(results).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map([...Object.values(results).flat(), ...more].map((en) => [en.id, en]));
  const src = {
    calls: [] as string[],
    down: false,
    failIds: new Set<string>(),
    byId,
    async search(query: string): Promise<Entry[]> {
      src.calls.push(`search:${normalizeTitle(query)}`);
      if (src.down) throw new SourceUnavailable('down');
      return byKey.get(normalizeTitle(query)) ?? [];
    },
    async entry(id: string): Promise<Entry | null> {
      src.calls.push(`entry:${id}`);
      if (src.down || src.failIds.has(id)) throw new SourceUnavailable('down');
      return byId.get(id) ?? null;
    },
  };
  return src;
}

function ev(path: string, titles: Record<string, string> = {}, fingerprint: string | null = null): DiscEvidence {
  return {
    discId: `id:${path}`,
    path,
    fingerprint,
    discTitles: Object.entries(titles).map(([lang, name]) => ({ lang, name })),
    segments: path.split('/').slice(1),
    catalogueNumbers: [],
    playlists: [],
  };
}

const EMBER = entry('anilist:100', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' }, { episodes: 12 });
const STARFALL = entry('anilist:400', { english: 'Starfall Traveler' }, { episodes: 12 });
const A = ev('drv1/Anime/火斬りの剣/[BDMV][220629][火斬りの剣][Vol.1]', { jpn: '火斬りの剣' });
const A2 = ev('drv1/Anime/火斬りの剣/[BDMV][220629][火斬りの剣][Vol.2]', { eng: 'Hinokiri no Ken' });
const B = ev('drv1/Anime/Starfall Traveler/[BDMV] Starfall Traveler Vol.1', { eng: 'Starfall Traveler' });
const UNKNOWN = ev('drv1/Misc/[BDMV] Nothing Like It', { eng: 'Nothing Like It' });

let dir: string;
let clock: number;
let timers: { fn: () => void; ms: number }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'title-service-'));
  clock = 1_000;
  timers = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function service(opts: { evidence: () => readonly DiscEvidence[]; anilist: MetadataSource; tmdb?: MetadataSource | null; owner?: OwnerStore; downloadRoots?: string[] }): TitleService {
  return new TitleService({
    library: { evidence: opts.evidence },
    owner: opts.owner ?? new OwnerStore(dir),
    dataDir: dir,
    anilist: opts.anilist,
    tmdb: opts.tmdb ?? null,
    discdb: { lookup: () => null },
    art: new ArtCache(join(dir, 'art'), vi.fn()),
    downloadRoots: new Set(opts.downloadRoots ?? []),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
}

const metadata = (): { cache: Record<string, unknown>; entries: Record<string, unknown> } => JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
const discsOf = (s: TitleService, id: string): number | undefined => s.catalogue().titles.find((t) => t.id === id)?.discs;
const reasonOf = (s: TitleService, d: DiscEvidence): string | undefined => s.catalogue().unsorted.find((u) => u.discId === d.discId)?.reason;

describe('TitleService', () => {
  it('builds the catalogue after a run and keeps it in metadata.json', async () => {
    const s = service({ evidence: () => [A], anilist: fake({ 火斬りの剣: [EMBER] }) });
    expect(s.catalogue().titles).toEqual([]);
    await s.runNow();
    expect(s.catalogue().titles.map((t) => t.id)).toEqual(['anilist:100']);
    expect(discsOf(s, 'anilist:100')).toBe(1);
    expect(existsSync(join(dir, 'metadata.json'))).toBe(true);
  });

  it('serves the last catalogue after a restart, before any run and with no source calls', async () => {
    await service({ evidence: () => [A], anilist: fake({ 火斬りの剣: [EMBER] }) }).runNow();
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist });
    expect(s.catalogue().titles.map((t) => t.id)).toEqual(['anilist:100']);
    await s.runNow();
    expect(anilist.calls).toEqual([]);
  });

  it('makes no source calls when a run finds the evidence unchanged', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist });
    await s.runNow();
    expect(anilist.calls.length).toBeGreaterThan(0);
    anilist.calls.length = 0;
    clock += DAY;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
  });

  it('keeps filed discs filed when the source is unreachable, marks the new groups and retries them next run (Review Focus 2)', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER], 'Hinokiri no Ken': [EMBER], 'Starfall Traveler': [STARFALL] });
    let evidence: DiscEvidence[] = [A];
    const s = service({ evidence: () => evidence, anilist });
    await s.runNow();
    expect(discsOf(s, 'anilist:100')).toBe(1);

    // A2 joins A's group (so the group is matched again), B is a new group, and the source is down
    evidence = [A, A2, B];
    anilist.down = true;
    clock += 60_000;
    await s.runNow();
    expect(discsOf(s, 'anilist:100')).toBe(1);
    expect(reasonOf(s, A)).toBeUndefined();
    expect(reasonOf(s, A2)).toBe('source-unreachable');
    expect(reasonOf(s, B)).toBe('source-unreachable');

    anilist.down = false;
    anilist.calls.length = 0;
    clock += 60_000;
    await s.runNow();
    expect(anilist.calls).toContain(`search:${normalizeTitle('Hinokiri no Ken')}`);
    expect(anilist.calls).toContain(`search:${normalizeTitle('Starfall Traveler')}`);
    expect(discsOf(s, 'anilist:100')).toBe(2);
    expect(discsOf(s, 'anilist:400')).toBe(1);
    expect(s.catalogue().unsorted).toEqual([]);
  });

  it('counts groups in its status during a run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = fake({ 火斬りの剣: [EMBER], 'Starfall Traveler': [STARFALL] });
    const anilist: MetadataSource = {
      search: async (q, o) => {
        await gate;
        return inner.search(q, o);
      },
      entry: (id) => inner.entry(id),
    };
    const s = service({ evidence: () => [A, B], anilist });
    expect(s.status()).toEqual({ running: false, groupsDone: 0, groupsTotal: 0, filed: 0, unsorted: 0, music: 0, lastRunAt: null, tmdb: false });
    const run = s.runNow();
    await Promise.resolve();
    expect(s.status()).toMatchObject({ running: true, groupsDone: 0, groupsTotal: 2 });
    release();
    await run;
    expect(s.status()).toEqual({ running: false, groupsDone: 2, groupsTotal: 2, filed: 2, unsorted: 0, music: 0, lastRunAt: clock, tmdb: false });
  });

  it("dates a disc's addedAt at its first sighting, unchanged by later runs", async () => {
    let evidence: DiscEvidence[] = [A];
    const anilist = fake({ 火斬りの剣: [EMBER], 'Starfall Traveler': [STARFALL] });
    const s = service({ evidence: () => evidence, anilist });
    clock = 5_000;
    await s.runNow();
    evidence = [{ ...A, catalogueNumbers: ['ABCD-12345'] }, B]; // A changed, so it is matched again
    clock = 9_000;
    await s.runNow();
    const added = (id: string): number | undefined => s.catalogue().titles.find((t) => t.id === id)?.addedAt;
    expect(added('anilist:100')).toBe(5_000);
    expect(added('anilist:400')).toBe(9_000);
    expect(service({ evidence: () => evidence, anilist }).catalogue().titles.find((t) => t.id === 'anilist:100')?.addedAt).toBe(5_000);
  });

  it('orders copies on the Downloads roots it is given last (C1)', async () => {
    const dl = ev('drv0-dl/Anime/火斬りの剣/[BDMV][220629][火斬りの剣][Vol.1]', { jpn: '火斬りの剣' });
    const s = service({ evidence: () => [dl, A], anilist: fake({ 火斬りの剣: [EMBER] }), downloadRoots: ['drv0-dl'] });
    await s.runNow();
    const copies = s.catalogue().detail('anilist:100')!.seasons[0]!.discs[0]!.copies;
    expect(copies.map((c) => c.root)).toEqual(['drv1', 'drv0-dl']);
  });

  it('names the roots in the Downloads group', () => {
    expect([...downloadRootNames([{ name: 'drv1', dir: '/a' }, { name: 'drv1-dl', dir: '/b', group: 'Downloads' }, { name: 'x', dir: '/c', group: 'Other' }])]).toEqual(['drv1-dl']);
  });

  it('loads the whole PREQUEL/SEQUEL chain of a filed entry, so its series is not provisional (C2)', async () => {
    const s1 = entry('anilist:300', { english: 'Ember Blade' }, { year: 2019, relations: [{ type: 'SEQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
    const s2 = entry('anilist:120', { english: 'Ember Blade Season 2' }, {
      year: 2021, episodes: 12,
      relations: [
        { type: 'PREQUEL', id: 'anilist:300', format: 'TV', startDate: 20190405 },
        { type: 'SEQUEL', id: 'anilist:450', format: 'TV', startDate: 20230701 },
      ],
    });
    const s3 = entry('anilist:450', { english: 'Ember Blade Season 3' }, { year: 2023, relations: [{ type: 'PREQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
    const disc = ev('drv1/Anime/[BDMV] Ember Blade Season 2 Vol.1', { eng: 'Ember Blade Season 2' });
    const anilist = fake({ 'Ember Blade': [s2] }, [s1, s3]);
    const s = service({ evidence: () => [disc], anilist });
    await s.runNow();
    expect(s.catalogue().titles.map((t) => t.id)).toEqual(['anilist:300']);
    expect(s.catalogue().provisional).toEqual([]);
    expect(Object.keys(metadata().entries).sort()).toEqual(['anilist:120', 'anilist:300', 'anilist:450']);
  });

  it('loads at most 30 entries of one chain', async () => {
    const chain = Array.from({ length: 40 }, (_, i) => entry(`anilist:${1000 + i}`, { english: i === 0 ? 'Long Saga' : `Long Saga Part ${i + 1}` }, {
      year: 2000 + i, episodes: 12,
      relations: i < 39 ? [{ type: 'SEQUEL', id: `anilist:${1001 + i}`, format: 'TV', startDate: (2001 + i) * 10000 + 101 }] : [],
    }));
    const disc = ev('drv1/Anime/[BDMV] Long Saga Vol.1', { eng: 'Long Saga' });
    const anilist = fake({ 'Long Saga': [chain[0]!] }, chain);
    const s = service({ evidence: () => [disc], anilist });
    await s.runNow();
    expect(discsOf(s, 'anilist:1000')).toBe(1);
    expect(Object.keys(metadata().entries).length).toBe(30);
  });

  it('keeps a filed disc when loading its chain fails, and loads the rest next run (C2, C5)', async () => {
    const s1 = entry('anilist:300', { english: 'Ember Blade' }, { year: 2019, episodes: 12, relations: [{ type: 'SEQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
    const s2 = entry('anilist:120', { english: 'Ember Blade Season 2' }, { year: 2021, relations: [{ type: 'PREQUEL', id: 'anilist:300', format: 'TV', startDate: 20190405 }] });
    const disc = ev('drv1/Anime/[BDMV] Ember Blade Vol.1', { eng: 'Ember Blade' });
    const anilist = fake({ 'Ember Blade': [s1] }, [s2]);
    anilist.failIds.add('anilist:120');
    const s = service({ evidence: () => [disc], anilist });
    await s.runNow();
    expect(discsOf(s, 'anilist:300')).toBe(1);
    expect(Object.keys(metadata().entries)).toEqual(['anilist:300']);

    anilist.failIds.clear();
    clock += 60_000;
    await s.runNow();
    expect(discsOf(s, 'anilist:300')).toBe(1);
    expect(Object.keys(metadata().entries).sort()).toEqual(['anilist:120', 'anilist:300']);
  });

  it('loads the entries owner choices name, so those discs leave Unsorted (C3)', async () => {
    const owner = new OwnerStore(dir);
    owner.setChoice(UNKNOWN.discId, null, { kind: 'title', titleId: 'tmdb-movie:77', season: null, disc: null });
    const tmdb = fake({}, [entry('tmdb-movie:77', { english: 'Nothing Like It' }, { year: 2020 })]);
    const s = service({ evidence: () => [UNKNOWN], anilist: fake({}), tmdb, owner });
    await s.runNow();
    expect(tmdb.calls).toContain('entry:tmdb-movie:77');
    expect(discsOf(s, 'tmdb-movie:77')).toBe(1);
    expect(s.catalogue().unsorted).toEqual([]);
  });

  it('reattaches owner choices to the present discs before building (C4)', async () => {
    const owner = new OwnerStore(dir);
    owner.setChoice('id:old-place', 'FP1', { kind: 'hidden' });
    const moved = ev('drv1/Misc/[BDMV] Nothing Like It', {}, 'FP1');
    const reattach = vi.spyOn(owner, 'reattach');
    const s = service({ evidence: () => [moved], anilist: fake({}), owner });
    await s.runNow();
    expect(reattach).toHaveBeenCalledWith([{ id: moved.discId, fingerprint: 'FP1' }]);
    expect(s.catalogue().hidden.map((d) => d.discId)).toEqual([moved.discId]);
  });

  it('rebuilds the catalogue after a choice change with no source calls (C6)', async () => {
    const owner = new OwnerStore(dir);
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist, owner });
    await s.runNow();
    anilist.calls.length = 0;
    owner.setChoice(A.discId, null, { kind: 'hidden' });
    s.rebuild();
    expect(s.catalogue().titles).toEqual([]);
    expect(s.catalogue().hidden.map((d) => d.discId)).toEqual([A.discId]);
    expect(anilist.calls).toEqual([]);
  });

  it('retries Unsorted weekly', async () => {
    const anilist = fake({});
    const s = service({ evidence: () => [UNKNOWN], anilist });
    await s.runNow();
    expect(reasonOf(s, UNKNOWN)).toBe('no-title');
    anilist.calls.length = 0;
    clock += 6 * DAY;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
    clock += 2 * DAY;
    await s.runNow();
    expect(anilist.calls).toContain(`search:${normalizeTitle('Nothing Like It')}`);
  });

  it('runs on its timer when the weekly retry is due', async () => {
    const anilist = fake({});
    const s = service({ evidence: () => [UNKNOWN], anilist });
    await s.runNow();
    anilist.calls.length = 0;
    expect(timers.length).toBe(1);
    expect(timers[0]!.ms).toBeLessThanOrEqual(DAY);
    clock += DAY;
    timers[0]!.fn();
    await Promise.resolve();
    expect(anilist.calls).toEqual([]);
    clock += 7 * DAY;
    timers[timers.length - 1]!.fn();
    await vi.waitFor(() => expect(anilist.calls.length).toBeGreaterThan(0));
    s.close();
  });

  it('refreshes entries older than 30 days monthly, and drops search results older than 30 days from metadata.json', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist });
    await s.runNow();
    expect(Object.keys(metadata().cache)).toContain(`anilist:${normalizeTitle('火斬りの剣')}`);
    anilist.byId.set('anilist:100', { ...EMBER, names: { ...EMBER.names, english: 'Ember Blade (renamed)' } });
    anilist.calls.length = 0;
    clock += 31 * DAY;
    await s.runNow();
    expect(anilist.calls).toEqual(['entry:anilist:100']);
    expect(s.catalogue().titles[0]!.names.english).toBe('Ember Blade (renamed)');
    expect(Object.keys(metadata().cache).filter((k) => !k.includes('-entry:'))).toEqual([]);
    anilist.calls.length = 0;
    clock += DAY;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
  });

  it('matches a box family together, so an added Box 2 is numbered after an unchanged Box 1 (T8b)', async () => {
    const tmdb = fake({ Brasswick: [entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: [{ number: 1, episodes: 12, runtimeMin: 24 }] })] });
    const box1 = [ev('drv1/TV/Brasswick/Brasswick BOX 1/DISC1'), ev('drv1/TV/Brasswick/Brasswick BOX 1/DISC2')];
    const box2 = ev('drv1/TV/Brasswick/Brasswick BOX 2/DISC1');
    let evidence = [...box1];
    const s = service({ evidence: () => evidence, anilist: fake({}), tmdb });
    await s.runNow();
    expect(discsOf(s, 'tmdb-tv:7')).toBe(2);
    evidence = [...box1, box2];
    clock += 60_000;
    await s.runNow();
    expect(s.catalogue().unsorted).toEqual([]);
    const slots = s.catalogue().detail('tmdb-tv:7')!.seasons[0]!.discs;
    expect(slots.map((d) => [d.number, d.copies[0]!.discId])).toEqual([[1, box1[0]!.discId], [2, box1[1]!.discId], [3, box2.discId]]);
  });

  it('caches an entry lookup that found nothing, and asks again only on the weekly retry (T8c)', async () => {
    const s1 = entry('anilist:300', { english: 'Ember Blade' }, { year: 2019, episodes: 12, relations: [{ type: 'SEQUEL', id: 'anilist:999', format: 'TV', startDate: 20210407 }] });
    const disc = ev('drv1/Anime/[BDMV] Ember Blade Vol.1', { eng: 'Ember Blade' });
    const anilist = fake({ 'Ember Blade': [s1] });
    const s = service({ evidence: () => [disc], anilist });
    await s.runNow();
    expect(anilist.calls).toContain('entry:anilist:999');
    anilist.calls.length = 0;
    clock += DAY;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
    expect(service({ evidence: () => [disc], anilist }).catalogue().titles.map((t) => t.id)).toEqual(['anilist:300']);
    clock += 7 * DAY;
    await s.runNow();
    expect(anilist.calls).toEqual(['entry:anilist:999']);
  });

  it('keeps a filed disc whose evidence changed during an outage filed until a re-match succeeds (T8d)', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER], 'Hinokiri no Ken': [EMBER] });
    let evidence: DiscEvidence[] = [A];
    const s = service({ evidence: () => evidence, anilist });
    await s.runNow();
    const changed = { ...A, discTitles: [...A.discTitles, { lang: 'eng', name: 'Hinokiri no Ken' }] };
    evidence = [changed];
    anilist.down = true;
    clock += 60_000;
    await s.runNow();
    expect(discsOf(s, 'anilist:100')).toBe(1);
    expect(s.catalogue().unsorted).toEqual([]);
    anilist.down = false;
    anilist.calls.length = 0;
    clock += 60_000;
    await s.runNow();
    expect(anilist.calls).toContain(`search:${normalizeTitle('Hinokiri no Ken')}`);
    expect(discsOf(s, 'anilist:100')).toBe(1);
    anilist.calls.length = 0;
    clock += 60_000;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
  });

  it('logs a failed run and still makes the run queued during it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = fake({ 火斬りの剣: [EMBER] });
    let first = true;
    const anilist: MetadataSource = {
      search: async (q, o) => {
        if (first) {
          first = false;
          await gate;
          throw new Error('boom');
        }
        return inner.search(q, o);
      },
      entry: (id) => inner.entry(id),
    };
    const s = service({ evidence: () => [A], anilist });
    const run = s.runNow();
    void s.runNow(); // a scan finishing during the run
    release();
    await run;
    expect(error).toHaveBeenCalledWith('title matching failed', expect.any(Error));
    expect(discsOf(s, 'anilist:100')).toBe(1);
    error.mockRestore();
  });

  it.each([
    ['not JSON', '{'],
    ['the wrong shape', JSON.stringify({ version: 1, matches: 'x' })],
    ['a bad entry', JSON.stringify({ version: 1, matches: [], entries: { a: { at: 1 } }, cache: {}, discs: {}, firstSeen: {}, lastRunAt: null, lastRetryAt: null, lastRefreshAt: null })],
  ])('sets a metadata.json that is %s aside and starts afresh (T8e)', async (_, text) => {
    writeFileSync(join(dir, 'metadata.json'), text);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    expect(s.catalogue().titles).toEqual([]);
    expect(readdirSync(dir)).toContain(`metadata.json.corrupt-${clock}`);
    expect(existsSync(join(dir, 'metadata.json'))).toBe(false);
    await s.runNow();
    expect(discsOf(s, 'anilist:100')).toBe(1);
  });

  it('takes the gate from the owner, else the config', () => {
    const owner = new OwnerStore(dir);
    const s = new TitleService({
      library: { evidence: () => [] }, owner, dataDir: dir, anilist: fake({}), tmdb: null, discdb: { lookup: () => null },
      art: new ArtCache(join(dir, 'art'), vi.fn()), titleLibrary: 'everyone', setTimer: () => () => {},
    });
    expect(s.gate()).toBe('everyone');
    owner.setGate('owners');
    expect(s.gate()).toBe('owners');
  });
});

describe('loadDiscDbOrNone', () => {
  it('means no TheDiscDB when the index is missing, logged once', () => {
    const log = vi.fn();
    const db = loadDiscDbOrNone(join(dir, 'missing.json'), log);
    expect(db.lookup('ABC')).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('loads an index', () => {
    const file = join(dir, 'index.json');
    writeFileSync(file, JSON.stringify({ discs: { ABC: { title: 'Ember Blade', kind: 'series', year: 2019, season: 1, disc: 1, episodes: [] } } }));
    expect(loadDiscDbOrNone(file, vi.fn()).lookup('abc')).toMatchObject({ title: 'Ember Blade' });
  });
});

describe('fixtureSources', () => {
  it('answers recorded searches by query and source, and entries by id', async () => {
    const tv = entry('tmdb-tv:5', { english: 'Starfall Traveler' });
    const { anilist, tmdb } = fixtureSources({ 'Starfall Traveler': [STARFALL, tv] });
    expect(await anilist.search('starfall traveler')).toEqual([STARFALL]);
    expect(await tmdb.search('Starfall Traveler')).toEqual([tv]);
    expect(await anilist.search('Other')).toEqual([]);
    expect(await tmdb.entry('tmdb-tv:5')).toEqual(tv);
    expect(await anilist.entry('anilist:1')).toBeNull();
  });
});
