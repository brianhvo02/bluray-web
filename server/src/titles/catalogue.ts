/**
 * The catalogue (spec §8): disc matches, metadata entries and the owner's choices made into titles (series, movies,
 * music), each with its seasons, disc slots with copies, episodes and extras, plus the Unsorted and Hidden lists.
 * Built afresh after every matching run or owner change, with no network access. Original code.
 */
import { createHash } from 'node:crypto';
import type {
  DiscRef, DiscSlot, EpisodeRef, OwnTitle, SeasonDetail, TitleDetail, TitleKind, TitleNames, TitleSummary, UnsortedItem, UnsortedReason,
} from '../../../src/engine/disc/nas-api';
import type { DiscDbHit } from './discdb';
import { guessEpisodes } from './episodes';
import type { DiscEvidence } from './evidence';
import { groupKey } from './match';
import type { DiscMatch } from './match';
import type { OwnerSnapshot } from './owner-store';
import type { Entry } from './sources';

export interface Catalogue {
  readonly titles: readonly TitleSummary[];
  detail(id: string): TitleDetail | null;
  readonly unsorted: readonly UnsortedItem[];
  readonly hidden: readonly DiscRef[];
  art(id: string): { small: string; large: string } | null;
}

export interface CatalogueInput {
  readonly matches: readonly DiscMatch[];
  readonly entries: ReadonlyMap<string, Entry>;
  readonly evidence: readonly DiscEvidence[];
  readonly owner: OwnerSnapshot;
  readonly discdb: { lookup(fp: string): DiscDbHit | null };
  /** Each disc id's first-seen time. */
  readonly addedAt: ReadonlyMap<string, number>;
}

const TV_FORMATS = new Set(['TV', 'TV_SHORT']);
const CHAIN_LINKS = new Set(['SEQUEL', 'PREQUEL']);

const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const hash = (text: string, length: number): string => createHash('sha256').update(text).digest('hex').slice(0, length);
const isAnilistTv = (en: Entry): boolean => en.source === 'anilist' && TV_FORMATS.has(en.format ?? '');

/** An AniList series: a chain of TV entries in start-date order, and each one's season number. */
interface Series {
  readonly id: string;
  readonly members: readonly Entry[];
  readonly number: ReadonlyMap<string, number>;
}

/** A disc placed in a title, with its disc number. */
interface Placed {
  readonly e: DiscEvidence;
  readonly disc: number | null;
}

interface SeasonBuild {
  readonly id: string;
  readonly label: string;
  readonly number: number | null;
  readonly order: number;
  readonly discs: Placed[];
  readonly extras: Placed[];
  /** What the episode guess needs, or null for no Episodes tab. */
  readonly info: { readonly episodes: number | null; readonly runtimeMin: number | null } | null;
  /** TheDiscDB episodes are kept when their season is this one; null keeps all. */
  readonly discDbSeason: number | null;
  /** Listed even without discs (an own series' declared seasons). */
  readonly fixed: boolean;
}

interface TitleBuild {
  readonly id: string;
  readonly kind: TitleKind;
  readonly names: TitleNames;
  readonly poster: string | null;
  readonly banner: string | null;
  readonly year: number | null;
  readonly own: boolean;
  /** Movies, music and AniList rows (films, OVAs) keep their discs in one season with no number. */
  readonly single: boolean;
  /** The AniList row entry this title is, to tie it to a series. */
  readonly row: Entry | null;
  readonly series: Series | null;
  readonly seasons: Map<string, SeasonBuild>;
  readonly extras: Placed[];
}

type Target = { readonly title: TitleBuild; readonly season: SeasonBuild | null };

/**
 * AniList series from the TV entries at hand (ruling T7a): entries linked by SEQUEL/PREQUEL form one chain, ordered by
 * start date. A link to an entry that isn't at hand is not followed, so a gap splits a chain rather than inventing a
 * season. Season numbers count from the chain's first entry, offset by the matcher's numbering (which saw the whole
 * chain) when a filed disc gives it.
 */
function anilistSeries(entries: ReadonlyMap<string, Entry>, matches: readonly DiscMatch[]): Map<string, Series> {
  const tv = [...entries.values()].filter(isAnilistTv);
  const links = new Map<string, Set<string>>(tv.map((en) => [en.id, new Set<string>()]));
  for (const en of tv) {
    for (const r of en.relations) {
      if (!CHAIN_LINKS.has(r.type) || !links.has(r.id) || r.id === en.id) continue;
      links.get(en.id)!.add(r.id);
      links.get(r.id)!.add(en.id);
    }
  }
  // an entry's start date is on the relations pointing at it
  const start = new Map<string, number>();
  for (const en of entries.values()) for (const r of en.relations) if (r.startDate !== null && !start.has(r.id)) start.set(r.id, r.startDate);
  const when = (en: Entry): number => start.get(en.id) ?? (en.year !== null ? en.year * 10000 : Number.MAX_SAFE_INTEGER);

  const out = new Map<string, Series>();
  for (const first of tv) {
    if (out.has(first.id)) continue;
    const ids = new Set([first.id]);
    const queue = [first.id];
    while (queue.length > 0) for (const next of links.get(queue.shift()!)!) if (!ids.has(next)) { ids.add(next); queue.push(next); }
    const members = [...ids].map((id) => entries.get(id)!).sort((a, b) => when(a) - when(b) || naturalOrder(a.id, b.id));
    let offset = 0;
    for (const m of matches) {
      if (m.status !== 'filed' || m.season === null || !ids.has(m.entryId)) continue;
      offset = Math.max(0, m.season - (members.findIndex((en) => en.id === m.entryId) + 1));
      break;
    }
    const series: Series = { id: members[0]!.id, members, number: new Map(members.map((en, i) => [en.id, i + 1 + offset])) };
    for (const id of ids) out.set(id, series);
  }
  return out;
}

export function buildCatalogue(input: CatalogueInput): Catalogue {
  const { entries, owner } = input;
  const evidenceById = new Map(input.evidence.map((e) => [e.discId, e]));
  const matchById = new Map(input.matches.map((m) => [m.discId, m]));
  const groupSizes = new Map<string, number>();
  for (const e of input.evidence) groupSizes.set(groupKey(e), (groupSizes.get(groupKey(e)) ?? 0) + 1);
  const seriesOf = anilistSeries(entries, input.matches);

  const artById = new Map<string, { small: string; large: string }>();
  const artId = (art: { small: string; large: string } | null): string | null => {
    if (art === null) return null;
    const id = hash(`${art.small}\n${art.large}`, 32);
    artById.set(id, art);
    return id;
  };

  const builds = new Map<string, TitleBuild>();
  const newTitle = (t: Omit<TitleBuild, 'seasons' | 'extras' | 'row' | 'series'> & { row?: Entry; series?: Series }): TitleBuild => {
    const b: TitleBuild = { ...t, row: t.row ?? null, series: t.series ?? null, seasons: new Map(), extras: [] };
    builds.set(b.id, b);
    return b;
  };
  const season = (b: TitleBuild, s: Omit<SeasonBuild, 'discs' | 'extras' | 'fixed'>, fixed = false): SeasonBuild => {
    let found = b.seasons.get(s.id);
    if (!found) {
      found = { ...s, discs: [], extras: [], fixed };
      b.seasons.set(s.id, found);
    }
    return found;
  };
  const entryNames = (en: Entry): TitleNames => ({ ...en.names, display: null });

  const seriesTitle = (series: Series): TitleBuild => {
    const head = series.members[0]!;
    return builds.get(series.id) ?? newTitle({
      id: series.id, kind: 'series', names: entryNames(head), year: head.year, own: false, single: false, series,
      poster: artId(series.members.find((en) => en.poster !== null)?.poster ?? null),
      banner: artId(bannerArt(series.members.find((en) => en.banner !== null)?.banner ?? null)),
    });
  };
  const entryTitle = (en: Entry): TitleBuild => builds.get(en.id) ?? newTitle({
    id: en.id, kind: en.kind, names: entryNames(en), year: en.year, own: false,
    single: en.source === 'anilist' || en.kind === 'movie', row: en.source === 'anilist' ? en : undefined,
    poster: artId(en.poster), banner: artId(bannerArt(en.banner)),
  });
  const singleSeason = (b: TitleBuild, info: SeasonBuild['info']): SeasonBuild =>
    season(b, { id: `${b.id}:discs`, label: '', number: null, order: 0, info, discDbSeason: null });
  const numbered = (b: TitleBuild, n: number, info: SeasonBuild['info'], discDbSeason: number | null): SeasonBuild =>
    season(b, { id: `${b.id}:s${n}`, label: `Season ${n}`, number: n, order: n, info, discDbSeason });

  const ownTitle = (t: OwnTitle): TitleBuild => {
    const existing = builds.get(t.id);
    if (existing) return existing;
    const b = newTitle({
      id: t.id, kind: t.kind, names: { english: null, romaji: null, native: null, synonyms: [], display: t.name },
      poster: null, banner: null, year: null, own: true, single: t.kind !== 'series',
    });
    if (t.kind === 'series') for (let n = 1; n <= (t.seasons ?? 0); n++) season(b, { id: `${b.id}:s${n}`, label: `Season ${n}`, number: n, order: n, info: null, discDbSeason: null }, true);
    return b;
  };
  for (const t of owner.ownTitles) ownTitle(t);

  /**
   * Where a disc filed under `titleId` goes. `season` null means: the entry's own season for an AniList TV entry, the
   * only season of a one-season series, or the title's extras for an extras disc. An owner's season number counts
   * within the whole AniList series; a match names the season by its entry.
   */
  const resolve = (titleId: string, seasonNo: number | null, extras: boolean, byOwner: boolean): Target | UnsortedReason => {
    if (titleId.startsWith('own:')) {
      const t = owner.ownTitles.find((o) => o.id === titleId);
      if (!t) return 'no-title';
      const b = ownTitle(t);
      if (b.single || (seasonNo === null && extras)) return { title: b, season: null };
      const n = seasonNo ?? (t.seasons === 1 ? 1 : null);
      return n === null ? 'no-season' : { title: b, season: numbered(b, n, null, null) };
    }
    const en = entries.get(titleId);
    // filed under an entry that isn't loaded yet (ruling T7c)
    if (!en) return 'no-title';
    if (isAnilistTv(en)) {
      const series = seriesOf.get(en.id)!;
      const b = seriesTitle(series);
      let member: Entry | undefined = en;
      if (byOwner && seasonNo !== null) member = series.members.find((m) => series.number.get(m.id) === seasonNo);
      else if (extras && seasonNo === null) return { title: b, season: null };
      if (!member) return 'no-season';
      const n = series.number.get(member.id)!;
      return {
        title: b,
        season: season(b, {
          id: member.id, label: member.names.english ?? member.names.romaji ?? `Season ${n}`, number: n, order: series.members.indexOf(member),
          info: { episodes: member.episodes, runtimeMin: member.runtimeMin }, discDbSeason: null,
        }),
      };
    }
    const b = entryTitle(en);
    if (b.single) return { title: b, season: null };
    const n = seasonNo ?? (extras ? null : en.seasons.length === 1 ? en.seasons[0]!.number : undefined);
    if (n === undefined) return 'no-season';
    if (n === null) return { title: b, season: null };
    const s = en.seasons.find((x) => x.number === n);
    return { title: b, season: numbered(b, n, s ? { episodes: s.episodes, runtimeMin: s.runtimeMin } : null, n) };
  };

  const put = (target: Target, p: Placed, extras: boolean): void => {
    const { title: b, season: s } = target;
    if (s !== null) (extras ? s.extras : s.discs).push(p);
    else if (extras) b.extras.push(p);
    else {
      const row = b.row;
      const info = row !== null && row.kind === 'series' ? { episodes: row.episodes, runtimeMin: row.runtimeMin } : null;
      singleSeason(b, info).discs.push(p);
    }
  };

  const music = (e: DiscEvidence, group: string, name: string, displayName: string | null): void => {
    const id = `music:${hash(group, 16)}`;
    const b = builds.get(id) ?? newTitle({
      id, kind: 'music', names: { english: name, romaji: null, native: null, synonyms: [], display: owner.displayNames.get(id) ?? displayName },
      poster: null, banner: null, year: null, own: false, single: true,
    });
    singleSeason(b, null).discs.push({ e, disc: null });
  };

  const discRef = (e: DiscEvidence): DiscRef => {
    const cut = e.path.indexOf('/');
    return {
      discId: e.discId,
      root: cut < 0 ? e.path : e.path.slice(0, cut),
      folder: cut < 0 ? '' : e.path.slice(cut + 1),
      displayName: owner.displayNames.get(e.discId) ?? null,
    };
  };

  const hidden: DiscRef[] = [];
  const unsortedDiscs: { e: DiscEvidence; reason: UnsortedReason; suggestions: readonly string[] }[] = [];
  for (const e of input.evidence) {
    const choice = owner.choices.get(e.discId);
    const match = matchById.get(e.discId);
    let target: Target | UnsortedReason;
    let disc: number | null = null;
    let extras = false;
    if (choice) {
      if (choice.kind === 'hidden') {
        hidden.push(discRef(e));
        continue;
      }
      if (choice.kind === 'music') {
        const group = match?.status === 'music' ? match.group : e.segments.slice(0, -1).join('/') || e.segments.join('/');
        music(e, group, match?.status === 'music' ? match.name : lastSegment(group), choice.name);
        continue;
      }
      extras = choice.kind === 'extras';
      disc = choice.kind === 'title' ? choice.disc : null;
      target = resolve(choice.titleId, choice.season, extras, true);
      if (typeof target === 'string') {
        const suggestions = match?.status === 'unsorted' ? match.suggestions : match?.status === 'filed' && entries.has(match.entryId) ? [match.entryId] : [];
        unsortedDiscs.push({ e, reason: target, suggestions });
        continue;
      }
    } else if (!match) {
      continue; // not matched yet
    } else if (match.status === 'music') {
      music(e, match.group, match.name, null);
      continue;
    } else if (match.status === 'unsorted') {
      unsortedDiscs.push({ e, reason: match.reason, suggestions: match.suggestions });
      continue;
    } else {
      extras = match.bonus;
      disc = match.disc;
      target = resolve(match.entryId, match.season, extras, false);
      if (typeof target === 'string') {
        unsortedDiscs.push({ e, reason: target, suggestions: entries.has(match.entryId) ? [match.entryId] : [] });
        continue;
      }
    }
    put(target, { e, disc }, extras);
  }

  // AniList rows (films, OVAs) related to a series in the catalogue are listed under it, not on their own
  const relatedOf = new Map<string, TitleBuild[]>();
  const attached = new Set<string>();
  const seriesBuilds = [...builds.values()].filter((s) => s.series !== null);
  for (const b of builds.values()) {
    const row = b.row;
    if (row === null) continue;
    const parent =
      row.relations.map((r) => seriesOf.get(r.id)).map((s) => (s ? builds.get(s.id) : undefined)).find((s) => s !== undefined) ??
      seriesBuilds.find((s) => s.series!.members.some((m) => m.relations.some((r) => r.id === row.id)));
    if (!parent) continue;
    attached.add(b.id);
    relatedOf.set(parent.id, [...(relatedOf.get(parent.id) ?? []), b]);
  }

  const copyOrder = (a: DiscRef, b: DiscRef): number =>
    Number(a.root.endsWith('-dl')) - Number(b.root.endsWith('-dl')) || naturalOrder(a.root, b.root) || naturalOrder(a.folder, b.folder);
  const slots = (placed: readonly Placed[]): DiscSlot[] => {
    const byKey = new Map<string, Placed[]>();
    for (const p of placed) {
      // the same disc number, or the same content without one, is one disc with several copies
      const key = p.disc !== null ? `n${p.disc}` : p.e.fingerprint !== null ? `f${p.e.fingerprint}` : `d${p.e.discId}`;
      byKey.set(key, [...(byKey.get(key) ?? []), p]);
    }
    return [...byKey.values()]
      .map((ps) => {
        const copies = ps.map((p) => discRef(p.e)).sort(copyOrder);
        const number = ps[0]!.disc;
        return { number, label: number !== null ? `Disc ${number}` : (copies[0]!.displayName ?? lastSegment(copies[0]!.folder)), copies };
      })
      .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || naturalOrder(a.copies[0]!.folder, b.copies[0]!.folder));
  };

  /** TheDiscDB's episodes when every disc has a hit (spec §8, 1), else the guess; episodes play from the first copy. */
  const episodes = (s: SeasonBuild, discs: readonly DiscSlot[]): EpisodeRef[] | null => {
    if (s.info === null || discs.length === 0) return null;
    const firsts = discs.map((d) => evidenceById.get(d.copies[0]!.discId)!);
    const hits = firsts.map((e) => (e.fingerprint !== null ? input.discdb.lookup(e.fingerprint) : null));
    if (hits.every((h) => h !== null && h.episodes.length > 0)) {
      const out = firsts.flatMap((e, i) => hits[i]!.episodes
        .filter((ep) => s.discDbSeason === null || ep.season === s.discDbSeason)
        .map((ep): EpisodeRef => {
          const playlist = e.playlists.find((p) => p.id === ep.playlist);
          return { number: ep.episode, name: ep.name, runtimeMin: playlist ? Math.round(playlist.durationS / 60) : null, discId: e.discId, playlistId: ep.playlist };
        }));
      if (out.length > 0) return out.sort((a, b) => a.number - b.number);
    }
    return guessEpisodes(s.info, firsts.map((e) => ({ discId: e.discId, playlists: e.playlists })), 1);
  };

  const details = new Map<string, Omit<TitleDetail, 'related'>>();
  const summaries = new Map<string, TitleSummary>();
  for (const b of builds.values()) {
    const seasons: SeasonDetail[] = [...b.seasons.values()]
      .filter((s) => s.fixed || s.discs.length > 0 || s.extras.length > 0)
      .sort((x, y) => x.order - y.order)
      .map((s) => {
        const discs = slots(s.discs);
        return { id: s.id, label: s.label, number: s.number, discs, episodes: b.own ? null : episodes(s, discs), extras: slots(s.extras) };
      });
    const extras = slots(b.extras);
    const placed = [...[...b.seasons.values()].flatMap((s) => [...s.discs, ...s.extras]), ...b.extras];
    const summary: TitleSummary = {
      id: b.id, kind: b.kind, names: b.names, poster: b.poster, year: b.year,
      seasons: b.single ? 0 : seasons.length,
      discs: seasons.reduce((n, s) => n + s.discs.length + s.extras.length, extras.length),
      addedAt: placed.reduce((max, p) => Math.max(max, input.addedAt.get(p.e.discId) ?? 0), 0),
      own: b.own,
    };
    summaries.set(b.id, summary);
    details.set(b.id, { title: summary, banner: b.banner, seasons, extras });
  }

  const entrySummary = (id: string): TitleSummary | null => {
    const known = summaries.get(id);
    if (known) return known;
    const en = entries.get(id);
    if (!en) return null;
    return { id, kind: en.kind, names: entryNames(en), poster: artId(en.poster), year: en.year, seasons: en.seasons.length, discs: 0, addedAt: 0, own: false };
  };
  const unsorted: UnsortedItem[] = unsortedDiscs.map(({ e, reason, suggestions }) => ({
    discId: e.discId,
    path: e.path,
    discTitles: e.discTitles,
    reason,
    suggestions: suggestions.map(entrySummary).filter((s): s is TitleSummary => s !== null),
    catalogueNumber: e.catalogueNumbers[0] ?? null,
    group: groupKey(e),
    groupSize: groupSizes.get(groupKey(e)) ?? 1,
  }));

  const byYear = (a: TitleSummary, b: TitleSummary): number => (a.year ?? Infinity) - (b.year ?? Infinity) || naturalOrder(a.id, b.id);
  const titles = [...summaries.values()].filter((s) => !attached.has(s.id)).sort((a, b) => naturalOrder(a.id, b.id));
  return {
    titles,
    detail(id) {
      const d = details.get(id);
      if (!d) return null;
      return { ...d, related: (relatedOf.get(id) ?? []).map((b) => summaries.get(b.id)!).sort(byYear) };
    },
    unsorted,
    hidden,
    art: (id) => artById.get(id) ?? null,
  };
}

/** A banner has one size. */
function bannerArt(url: string | null): { small: string; large: string } | null {
  return url === null ? null : { small: url, large: url };
}
