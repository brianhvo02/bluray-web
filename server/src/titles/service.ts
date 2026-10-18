/**
 * The title service: matches new and changed discs after every library scan, keeps the last catalogue (and what built
 * it) in `<dataDir>/metadata.json` so a restart serves it with no network access, and refreshes on a schedule: Unsorted
 * is retried weekly, entries older than 30 days are fetched again monthly. Original code.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTitle } from '../../../src/engine/disc/title-text';
import { isCode, replaceAtomically } from '../atomic-json';
import type { LibraryRoot } from '../config';
import type { Library } from '../library';
import type { ArtCache } from './art';
import { buildCatalogue } from './catalogue';
import type { Catalogue } from './catalogue';
import { loadDiscDb } from './discdb';
import type { DiscDbHit } from './discdb';
import type { DiscEvidence } from './evidence';
import { groupKey, matchDiscs } from './match';
import type { DiscMatch } from './match';
import type { OwnerStore } from './owner-store';
import { SourceUnavailable } from './sources';
import type { Entry, MetadataSource } from './sources';

const DAY_MS = 86_400_000;
const RETRY_UNSORTED_MS = 7 * DAY_MS;
const REFRESH_MS = 30 * DAY_MS;
/** Search results older than this are dropped from the cache (and so from metadata.json). */
const SEARCH_CACHE_MS = 30 * DAY_MS;
/** How often the timer checks whether a retry or refresh is due. */
const TICK_MS = DAY_MS;
/** Entries loaded per PREQUEL/SEQUEL chain, at most (ruling T8a). */
const MAX_CHAIN_ENTRIES = 30;
const TV_FORMATS = new Set(['TV', 'TV_SHORT']);
/** The matcher's cache keys for entries looked up by id (`anilist-entry:anilist:1`, `tmdb-entry:tmdb-tv:2`). */
const ENTRY_KEY = /^(?:anilist|tmdb)-entry:(.+)$/;

export interface TitleStatus { readonly running: boolean; readonly groupsDone: number; readonly groupsTotal: number; readonly filed: number; readonly unsorted: number; readonly music: number; readonly lastRunAt: number | null; readonly tmdb: boolean }

export interface TitleServiceOptions {
  readonly library: Pick<Library, 'evidence'>;
  readonly owner: OwnerStore;
  readonly dataDir: string;
  readonly anilist: MetadataSource;
  readonly tmdb: MetadataSource | null;
  readonly discdb: { lookup(fp: string): DiscDbHit | null };
  readonly art: ArtCache;
  /** Roots in the Downloads group (see `downloadRootNames`). */
  readonly downloadRoots?: ReadonlySet<string>;
  /** `TITLE_LIBRARY`, used while the owner hasn't set the gate. Default 'owners'. */
  readonly titleLibrary?: 'owners' | 'everyone';
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

interface Dated<T> {
  readonly at: number;
  readonly value: T;
}

/** metadata.json. */
interface MetadataFile {
  readonly version: 1;
  readonly matches: readonly DiscMatch[];
  readonly entries: Record<string, Dated<Entry>>;
  /** The matcher's cache: search results and entries looked up by id, with when they were fetched. */
  readonly cache: Record<string, Dated<Entry[]>>;
  /** Each present disc's evidence key and group. */
  readonly discs: Record<string, { readonly key: string; readonly group: string }>;
  /** Each disc id's first-seen time. */
  readonly firstSeen: Record<string, number>;
  readonly lastRunAt: number | null;
  readonly lastRetryAt: number | null;
  readonly lastRefreshAt: number | null;
}

const evidenceKey = (e: DiscEvidence): string => createHash('sha256').update(JSON.stringify(e)).digest('hex').slice(0, 32);
const sourceOf = (id: string): 'anilist' | 'tmdb' | null => (id.startsWith('anilist:') ? 'anilist' : id.startsWith('tmdb-') ? 'tmdb' : null);

function defaultTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
}

/** The names of the roots whose group is "Downloads": their copies are listed after the others. */
export function downloadRootNames(roots: readonly LibraryRoot[]): Set<string> {
  return new Set(roots.filter((r) => r.group === 'Downloads').map((r) => r.name));
}

/** The TheDiscDB index at `file`, or none when it is missing or unreadable (ruling R2), which is logged once. */
export function loadDiscDbOrNone(file: string, log: (message: string) => void = console.log): { lookup(fp: string): DiscDbHit | null } {
  try {
    return loadDiscDb(file);
  } catch (err) {
    log(`TheDiscDB index ${file} not loaded (${err instanceof Error ? err.message : String(err)}): matching without TheDiscDB`);
    return { lookup: () => null };
  }
}

/**
 * Test-only sources (ruling R3, `METADATA_FIXTURE`): recorded search results keyed by query stand in for AniList and
 * TMDB. A query matches under `normalizeTitle`; each source answers its own entries, and entries by id from all of them.
 */
export function fixtureSources(recorded: Readonly<Record<string, readonly Entry[]>>): { anilist: MetadataSource; tmdb: MetadataSource } {
  const byQuery = new Map(Object.entries(recorded).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map(Object.values(recorded).flat().map((en) => [en.id, en]));
  const source = (name: 'anilist' | 'tmdb'): MetadataSource => ({
    search: async (query) => (byQuery.get(normalizeTitle(query)) ?? []).filter((en) => en.source === name),
    entry: async (id) => (sourceOf(id) === name ? (byId.get(id) ?? null) : null),
  });
  return { anilist: source('anilist'), tmdb: source('tmdb') };
}

export class TitleService {
  private readonly file: string;
  private readonly now: () => number;
  readonly art: ArtCache;
  private matches = new Map<string, DiscMatch>();
  private entries = new Map<string, Dated<Entry>>();
  private cache = new Map<string, Dated<Entry[]>>();
  private discs = new Map<string, { key: string; group: string }>();
  private readonly firstSeen = new Map<string, number>();
  private lastRunAt: number | null = null;
  private lastRetryAt: number | null = null;
  private lastRefreshAt: number | null = null;
  private built!: Catalogue;
  private running: Promise<void> | null = null;
  private again = false;
  private groupsDone = 0;
  private groupsTotal = 0;
  private cancelTimer: () => void = () => {};

  constructor(private readonly opts: TitleServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.art = opts.art;
    mkdirSync(opts.dataDir, { recursive: true });
    this.file = join(opts.dataDir, 'metadata.json');
    this.load();
    this.rebuild();
    this.arm();
  }

  /** The last built catalogue; served while a run is going. */
  catalogue(): Catalogue {
    return this.built;
  }

  status(): TitleStatus {
    let filed = 0;
    let music = 0;
    for (const t of this.built.titles) {
      if (t.kind === 'music') music += t.discs;
      else filed += t.discs;
    }
    return {
      running: this.running !== null, groupsDone: this.groupsDone, groupsTotal: this.groupsTotal, filed, unsorted: this.built.unsorted.length, music,
      lastRunAt: this.lastRunAt, tmdb: this.opts.tmdb !== null,
    };
  }

  /** The owner's setting, else the config's. */
  gate(): 'owners' | 'everyone' {
    return this.opts.owner.snapshot().gate ?? this.opts.titleLibrary ?? 'owners';
  }

  /**
   * Matches new and changed discs (and their groups), plus Unsorted when the weekly retry is due, then rebuilds and
   * saves. A call during a run returns that run, which goes round once more so it sees the latest scan.
   */
  runNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.run();
        } while (this.again);
      } catch (err) {
        console.error('title matching failed', err);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Builds the catalogue again from what is known, with no network access: after an owner change. */
  rebuild(): void {
    this.built = buildCatalogue({
      matches: [...this.matches.values()],
      entries: new Map([...this.entries].map(([id, d]) => [id, d.value])),
      evidence: this.opts.library.evidence(),
      owner: this.opts.owner.snapshot(),
      discdb: this.opts.discdb,
      addedAt: this.firstSeen,
      downloadRoots: this.opts.downloadRoots ?? new Set(),
    });
  }

  /** Stops the schedule. */
  close(): void {
    this.cancelTimer();
  }

  private arm(): void {
    this.cancelTimer = (this.opts.setTimer ?? defaultTimer)(() => {
      if (this.due(this.lastRetryAt, RETRY_UNSORTED_MS) || this.due(this.lastRefreshAt, REFRESH_MS)) void this.runNow();
      this.arm();
    }, TICK_MS);
  }

  private due(last: number | null, every: number): boolean {
    return last !== null && this.now() - last >= every;
  }

  private async run(): Promise<void> {
    const { owner, anilist, tmdb } = this.opts;
    const now = this.now();
    const evidence = this.opts.library.evidence();
    owner.reattach(evidence.map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
    for (const e of evidence) if (!this.firstSeen.has(e.discId)) this.firstSeen.set(e.discId, now);
    const retryDue = this.due(this.lastRetryAt, RETRY_UNSORTED_MS);

    // groups to match: those with a new or changed disc, a disc that left, a source failure, or Unsorted on retry day
    const discs = new Map(evidence.map((e) => [e.discId, { key: evidenceKey(e), group: groupKey(e) }]));
    const dirty = new Set<string>();
    for (const [id, d] of discs) {
      const before = this.discs.get(id);
      const m = this.matches.get(id);
      if (!before || before.key !== d.key || !m || (m.status === 'unsorted' && (m.reason === 'source-unreachable' || retryDue))) dirty.add(d.group);
    }
    for (const [id, d] of this.discs) if (!discs.has(id)) dirty.add(d.group);
    const toMatch = evidence.filter((e) => dirty.has(groupKey(e)));

    // the matcher's cache; on retry day, search results older than a week are looked up again
    const cache = new Map<string, Entry[]>();
    for (const [k, d] of this.cache) {
      if (retryDue && !ENTRY_KEY.test(k) && now - d.at >= RETRY_UNSORTED_MS) continue;
      cache.set(k, d.value);
    }
    this.groupsDone = 0;
    this.groupsTotal = new Set(toMatch.map(groupKey)).size;
    const result = toMatch.length === 0
      ? { matches: [], entries: new Map<string, Entry>() }
      : await matchDiscs(toMatch, { anilist, tmdb, discdb: this.opts.discdb, cache, onGroupDone: () => this.groupsDone++ });

    let failed = false;
    const matches = new Map<string, DiscMatch>();
    for (const e of evidence) {
      const m = this.matches.get(e.discId);
      if (m) matches.set(e.discId, m);
    }
    for (const m of result.matches) {
      const before = this.matches.get(m.discId);
      if (m.status === 'unsorted' && m.reason === 'source-unreachable') {
        failed = true;
        // a disc filed before, whose evidence is unchanged, stays filed (Review Focus 2)
        if (before && before.status !== 'unsorted' && this.discs.get(m.discId)?.key === discs.get(m.discId)!.key) continue;
      }
      matches.set(m.discId, m);
    }

    const entries = new Map(this.entries);
    for (const [id, en] of result.entries) if (!entries.has(id)) entries.set(id, { at: now, value: en });
    const byId = async (id: string): Promise<Entry | null> => {
      const src = sourceOf(id) === 'anilist' ? anilist : sourceOf(id) === 'tmdb' ? tmdb : null;
      if (!src) return null;
      const key = `${sourceOf(id)}-entry:${id}`;
      let hit = cache.get(key);
      if (!hit) {
        const en = await src.entry(id);
        hit = en ? [en] : [];
        cache.set(key, hit);
      }
      return hit[0] ?? null;
    };
    const load = async (id: string): Promise<Entry | null> => {
      const known = entries.get(id);
      if (known) return known.value;
      const en = await byId(id);
      if (en) entries.set(id, { at: now, value: en });
      return en;
    };

    const keep = new Set<string>();
    try {
      // entries named by owner choices (C3)
      const anilistStarts: string[] = [];
      for (const c of owner.snapshot().choices.values()) {
        if (c.kind !== 'title' && c.kind !== 'extras') continue;
        if (sourceOf(c.titleId) === null) continue;
        keep.add(c.titleId);
        if ((await load(c.titleId)) && sourceOf(c.titleId) === 'anilist') anilistStarts.push(c.titleId);
      }
      for (const m of matches.values()) {
        if (m.status === 'filed') keep.add(m.entryId);
        if (m.status === 'unsorted') for (const id of m.suggestions) keep.add(id);
        if (m.status === 'filed' && sourceOf(m.entryId) === 'anilist') anilistStarts.push(m.entryId);
      }
      // every entry on the TV PREQUEL/SEQUEL chain of a filed AniList entry, so its series has its root (C2)
      const walked = new Set<string>();
      for (const start of anilistStarts) {
        const queue = [start];
        let count = 0;
        while (queue.length > 0 && count < MAX_CHAIN_ENTRIES) {
          const id = queue.shift()!;
          if (walked.has(id)) continue;
          walked.add(id);
          keep.add(id);
          count++;
          const en = await load(id);
          if (!en) continue;
          for (const r of en.relations) {
            if ((r.type === 'PREQUEL' || r.type === 'SEQUEL') && TV_FORMATS.has(r.format ?? '') && !walked.has(r.id)) queue.push(r.id);
          }
        }
      }
    } catch (err) {
      if (!(err instanceof SourceUnavailable)) throw err;
      failed = true;
    }
    // unreferenced entries go, unless a lookup failed and the walk is incomplete (C5)
    if (!failed) for (const id of entries.keys()) if (!keep.has(id)) entries.delete(id);

    // monthly: entries older than 30 days are fetched again
    let refreshed = true;
    if (this.due(this.lastRefreshAt, REFRESH_MS)) {
      try {
        for (const [id, d] of entries) {
          if (now - d.at < REFRESH_MS) continue;
          const src = sourceOf(id) === 'anilist' ? anilist : sourceOf(id) === 'tmdb' ? tmdb : null;
          const en = src ? await src.entry(id) : null;
          if (!en) continue;
          entries.set(id, { at: now, value: en });
          cache.set(`${sourceOf(id)}-entry:${id}`, [en]);
        }
      } catch (err) {
        if (!(err instanceof SourceUnavailable)) throw err;
        refreshed = false;
      }
    }

    const nextCache = new Map<string, Dated<Entry[]>>();
    for (const [k, v] of cache) {
      const before = this.cache.get(k);
      nextCache.set(k, before && before.value === v ? before : { at: now, value: v });
    }
    for (const [k, d] of this.cache) if (!nextCache.has(k)) nextCache.set(k, d);
    for (const [k, d] of nextCache) {
      // search results older than 30 days go; entry lookups stay while their entry does
      const id = ENTRY_KEY.exec(k)?.[1];
      if (id === undefined ? now - d.at >= SEARCH_CACHE_MS : !failed && !entries.has(id)) nextCache.delete(k);
    }

    this.matches = matches;
    this.entries = entries;
    this.cache = nextCache;
    this.discs = discs;
    this.lastRunAt = now;
    if (this.lastRetryAt === null || retryDue) this.lastRetryAt = now;
    if (this.lastRefreshAt === null || (refreshed && this.due(this.lastRefreshAt, REFRESH_MS))) this.lastRefreshAt = now;
    this.rebuild();
    this.save();
  }

  private load(): void {
    let data: MetadataFile;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8')) as MetadataFile;
    } catch (err) {
      if (!isCode(err, 'ENOENT')) console.error(`${this.file} is unreadable; matching starts afresh`, err);
      return;
    }
    if (data?.version !== 1) return;
    this.matches = new Map(data.matches.map((m) => [m.discId, m]));
    this.entries = new Map(Object.entries(data.entries));
    this.cache = new Map(Object.entries(data.cache));
    this.discs = new Map(Object.entries(data.discs));
    for (const [id, at] of Object.entries(data.firstSeen)) this.firstSeen.set(id, at);
    this.lastRunAt = data.lastRunAt;
    this.lastRetryAt = data.lastRetryAt;
    this.lastRefreshAt = data.lastRefreshAt;
  }

  private save(): void {
    const data: MetadataFile = {
      version: 1,
      matches: [...this.matches.values()],
      entries: Object.fromEntries(this.entries),
      cache: Object.fromEntries(this.cache),
      discs: Object.fromEntries(this.discs),
      firstSeen: Object.fromEntries(this.firstSeen),
      lastRunAt: this.lastRunAt,
      lastRetryAt: this.lastRetryAt,
      lastRefreshAt: this.lastRefreshAt,
    };
    replaceAtomically(this.file, JSON.stringify(data));
  }
}
