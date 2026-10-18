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
import { groupKey, musicRelease } from './match';
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
  /** Roots in the Downloads group: their copies come after the others. */
  readonly downloadRoots: ReadonlySet<string>;
}

const TV_FORMATS = new Set(['TV', 'TV_SHORT']);
/** Relations that tie a film or OVA to a series; CHARACTER, OTHER and the like don't. */
const STORY_LINKS = new Set(['SEQUEL', 'PREQUEL', 'PARENT', 'SIDE_STORY', 'SUMMARY']);

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
 * AniList series (rulings T7a, T7f). TV/TV_SHORT entries and the TV ids their SEQUEL/PREQUEL relations name, loaded or
 * not, form a graph; a connected part of it is one series. Its root is the node with no prequel (the earliest by start
 * date if several), so the series id is the first season's even when that entry isn't loaded. A loaded entry's season
 * number is its place on the longest prequel path from a root. Seasons that aren't loaded are absent, never invented.
 */
function anilistSeries(entries: ReadonlyMap<string, Entry>): Map<string, Series> {
  const isTvNode = (id: string): boolean => {
    const en = entries.get(id);
    return en === undefined || isAnilistTv(en);
  };
  const next = new Map<string, Set<string>>();
  const prev = new Map<string, Set<string>>();
  const node = (id: string): void => {
    if (!next.has(id)) { next.set(id, new Set()); prev.set(id, new Set()); }
  };
  const link = (from: string, to: string): void => {
    node(from);
    node(to);
    next.get(from)!.add(to);
    prev.get(to)!.add(from);
  };
  for (const en of entries.values()) {
    if (!isAnilistTv(en)) continue;
    node(en.id);
    for (const r of en.relations) {
      if (r.id === en.id || !TV_FORMATS.has(r.format ?? '') || !isTvNode(r.id)) continue;
      if (r.type === 'PREQUEL') link(r.id, en.id);
      else if (r.type === 'SEQUEL') link(en.id, r.id);
    }
  }
  // an entry's start date is on the relations pointing at it
  const start = new Map<string, number>();
  for (const en of entries.values()) for (const r of en.relations) if (r.startDate !== null && !start.has(r.id)) start.set(r.id, r.startDate);
  const when = (id: string): number => {
    const year = entries.get(id)?.year ?? null;
    return start.get(id) ?? (year !== null ? year * 10000 : Number.MAX_SAFE_INTEGER);
  };
  const byDate = (a: string, b: string): number => when(a) - when(b) || naturalOrder(a, b);

  const out = new Map<string, Series>();
  for (const first of next.keys()) {
    if (out.has(first) || !entries.has(first)) continue;
    const ids = new Set([first]);
    const queue = [first];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const n of [...next.get(id)!, ...prev.get(id)!]) if (!ids.has(n)) { ids.add(n); queue.push(n); }
    }
    const roots = [...ids].filter((id) => prev.get(id)!.size === 0).sort(byDate);
    if (roots.length === 0) roots.push([...ids].sort(byDate)[0]!); // a cycle
    // longest path from a root, bounded so that a cycle ends
    const depth = new Map(roots.map((id) => [id, 0]));
    const walk = [...roots];
    while (walk.length > 0) {
      const id = walk.shift()!;
      const d = depth.get(id)! + 1;
      for (const n of next.get(id)!) {
        if (d < ids.size && d > (depth.get(n) ?? -1)) { depth.set(n, d); walk.push(n); }
      }
    }
    const members = [...ids].filter((id) => entries.has(id))
      .sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0) || byDate(a, b))
      .map((id) => entries.get(id)!);
    const series: Series = { id: roots[0]!, members, number: new Map(members.map((en) => [en.id, (depth.get(en.id) ?? 0) + 1])) };
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
  const seriesOf = anilistSeries(entries);

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
    id: en.id, kind: en.source === 'anilist' ? 'movie' : en.kind, names: entryNames(en), year: en.year, own: false,
    single: en.source === 'anilist' || en.kind === 'movie', row: en.source === 'anilist' ? en : undefined,
    poster: artId(en.poster), banner: artId(bannerArt(en.banner)),
  });
  const singleSeason = (b: TitleBuild, info: SeasonBuild['info']): SeasonBuild =>
    season(b, { id: `${b.id}#discs`, label: '', number: null, order: 0, info, discDbSeason: null });
  const numbered = (b: TitleBuild, n: number, info: SeasonBuild['info'], discDbSeason: number | null, fixed = false): SeasonBuild =>
    season(b, { id: `${b.id}#s${n}`, label: `Season ${n}`, number: n, order: n, info, discDbSeason }, fixed);

  const ownTitle = (t: OwnTitle): TitleBuild => {
    const existing = builds.get(t.id);
    if (existing) return existing;
    const b = newTitle({
      id: t.id, kind: t.kind, names: { english: null, romaji: null, native: null, synonyms: [], display: t.name },
      poster: null, banner: null, year: null, own: true, single: t.kind !== 'series',
    });
    if (t.kind === 'series') for (let n = 1; n <= (t.seasons ?? 0); n++) numbered(b, n, null, null, true);
    return b;
  };
  for (const t of owner.ownTitles) ownTitle(t);

  /**
   * Where a disc filed under `titleId` goes. `season` null means: the entry's own season for an AniList TV entry (even
   * for a bonus disc), the title's extras for an owner's extras of the series itself, the only season of a one-season
   * series, or the title's extras for an extras disc. An owner's season number counts within the whole AniList series;
   * a match names the season by its entry. A season the entry or own title doesn't have goes to Unsorted.
   */
  const resolve = (titleId: string, seasonNo: number | null, extras: boolean, byOwner: boolean): Target | UnsortedReason => {
    if (titleId.startsWith('own:')) {
      const t = owner.ownTitles.find((o) => o.id === titleId);
      if (!t) return 'no-title';
      const b = ownTitle(t);
      if (b.single || (seasonNo === null && extras)) return { title: b, season: null };
      const n = seasonNo ?? (t.seasons === 1 ? 1 : null);
      if (n === null || n < 1 || (t.seasons !== null && n > t.seasons)) return 'no-season';
      return { title: b, season: numbered(b, n, null, null) };
    }
    const en = entries.get(titleId);
    // filed under an entry that isn't loaded yet (ruling T7c)
    if (!en) return 'no-title';
    if (isAnilistTv(en)) {
      const series = seriesOf.get(en.id)!;
      const b = seriesTitle(series);
      let member: Entry | undefined = en;
      if (byOwner && seasonNo !== null) member = series.members.find((m) => series.number.get(m.id) === seasonNo);
      else if (byOwner && extras && seasonNo === null && en.id === series.id) return { title: b, season: null };
      if (!member) return 'no-season';
      const n = series.number.get(member.id)!;
      return {
        title: b,
        season: season(b, {
          id: `${member.id}#season`, label: member.names.english ?? member.names.romaji ?? `Season ${n}`, number: n, order: series.members.indexOf(member),
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
    if (!s && en.seasons.length > 0) return 'no-season';
    return { title: b, season: numbered(b, n, s ? { episodes: s.episodes, runtimeMin: s.runtimeMin } : null, n) };
  };

  const put = (target: Target, p: Placed, extras: boolean): void => {
    const { title: b, season: s } = target;
    if (s !== null) (extras ? s.extras : s.discs).push(p);
    else if (extras) b.extras.push(p);
    else {
      const row = b.row;
      const info = row !== null && row.format !== 'MOVIE' ? { episodes: row.episodes, runtimeMin: row.runtimeMin } : null;
      singleSeason(b, info).discs.push(p);
    }
  };

  /** The name in an owner's music choice on any disc of a music title, by title id. */
  const musicChoiceNames = new Map<string, string>();
  const music = (e: DiscEvidence, group: string, name: string, choiceName: string | null): void => {
    const id = `music:${hash(group, 16)}`;
    const b = builds.get(id) ?? newTitle({
      id, kind: 'music', names: { english: name, romaji: null, native: null, synonyms: [], display: null },
      poster: null, banner: null, year: null, own: false, single: true,
    });
    if (choiceName !== null && !musicChoiceNames.has(id)) musicChoiceNames.set(id, choiceName);
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
        // the music release folder, as the matcher finds it, else the disc folder itself
        const group = match?.status === 'music' ? match.group : (musicRelease(e) ?? e.segments.join('/'));
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

  // AniList rows (films, OVAs) tied to a series in the catalogue by a story relation are also listed under it (T7e)
  const relatedOf = new Map<string, TitleBuild[]>();
  const seriesBuilds = [...builds.values()].filter((s) => s.series !== null);
  for (const b of builds.values()) {
    const row = b.row;
    if (row === null) continue;
    const parent =
      row.relations.filter((r) => STORY_LINKS.has(r.type)).map((r) => seriesOf.get(r.id)).map((s) => (s ? builds.get(s.id) : undefined)).find((s) => s !== undefined) ??
      seriesBuilds.find((s) => s.series!.members.some((m) => m.relations.some((r) => r.id === row.id && STORY_LINKS.has(r.type))));
    if (!parent) continue;
    relatedOf.set(parent.id, [...(relatedOf.get(parent.id) ?? []), b]);
  }

  const download = (root: string): number => Number(input.downloadRoots.has(root));
  const copyOrder = (a: DiscRef, b: DiscRef): number =>
    download(a.root) - download(b.root) || naturalOrder(a.root, b.root) || naturalOrder(a.folder, b.folder);
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

  /**
   * TheDiscDB's episodes when every disc's first copy has a hit (spec §8, 1), else the guess. Episodes play from the
   * first copy; a TheDiscDB episode whose playlist that copy lacks plays from a copy that has it, or is left out.
   */
  const episodes = (s: SeasonBuild, discs: readonly DiscSlot[]): EpisodeRef[] | null => {
    if (s.info === null || discs.length === 0) return null;
    const copies = discs.map((d) => d.copies.map((c) => evidenceById.get(c.discId)!));
    const firsts = copies.map((cs) => cs[0]!);
    const hits = firsts.map((e) => (e.fingerprint !== null ? input.discdb.lookup(e.fingerprint) : null));
    if (hits.every((h) => h !== null && h.episodes.length > 0)) {
      const out = copies.flatMap((cs, i) => hits[i]!.episodes
        .filter((ep) => s.discDbSeason === null || ep.season === s.discDbSeason)
        .flatMap((ep): EpisodeRef[] => {
          for (const e of cs) {
            const playlist = e.playlists.find((p) => p.id === ep.playlist);
            if (playlist) return [{ number: ep.episode, name: ep.name, runtimeMin: Math.round(playlist.durationS / 60), discId: e.discId, playlistId: ep.playlist }];
          }
          return [];
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
      id: b.id, kind: b.kind, poster: b.poster, year: b.year,
      names: b.kind === 'music' && !b.own ? { ...b.names, display: owner.displayNames.get(b.id) ?? musicChoiceNames.get(b.id) ?? null } : b.names,
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
  const titles = [...summaries.values()].sort((a, b) => naturalOrder(a.id, b.id));
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
