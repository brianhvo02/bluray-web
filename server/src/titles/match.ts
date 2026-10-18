/**
 * Cautious matching (spec §7): discs are grouped by parent folder, their names are looked up on AniList and TMDB, and a
 * disc is filed only when the four acceptance rules hold. Everything else goes to Unsorted with a reason, because a
 * confident wrong match is worse than Unsorted. Original code.
 */
import type { UnsortedReason } from '../../../src/engine/disc/nas-api';
import { normalizeTitle } from '../../../src/engine/disc/title-text';
import type { DiscDbHit } from './discdb';
import type { DiscEvidence } from './evidence';
import { parseName } from './parse-name';
import type { ParsedName } from './parse-name';
import { SourceUnavailable } from './sources';
import type { Entry, MetadataSource } from './sources';

type Via = 'disc-title' | 'folder' | 'discdb';

export type DiscMatch =
  | { readonly discId: string; readonly status: 'filed'; readonly entryId: string; readonly season: number | null; readonly disc: number | null; readonly bonus: boolean; readonly via: readonly Via[] }
  | { readonly discId: string; readonly status: 'music'; readonly group: string; readonly name: string }
  | { readonly discId: string; readonly status: 'unsorted'; readonly reason: UnsortedReason; readonly suggestions: readonly string[] }; // suggestions: entry ids, up to 3

export interface MatchContext {
  readonly anilist: MetadataSource;
  readonly tmdb: MetadataSource | null;
  readonly discdb: { lookup(fp: string): DiscDbHit | null };
  /** Search results by source and normalised query, so a group's (and a run's) lookups happen once. */
  readonly cache: Map<string, Entry[]>;
}

/**
 * How well a candidate fits an entry. EXACT: the normalised candidate equals one of the entry's names, or equals a name
 * with its structure stripped (`Citadel Season 2` → `Citadel`) and the stripped season agrees with the evidence's.
 * BASE: it equals a stripped name otherwise, so the title agrees but the season or part is unclear.
 */
const EXACT = 2;
const BASE = 1;
/** A parse's later candidates (a stripped variant, the un-stripped `X 2`) are less certain: they score at most BASE. */
const LATER_CANDIDATE_MAX = BASE;
/**
 * A rival entry "comes close" (rule 1) when its score is at least this share of the best entry's score. Scores are
 * small sums of EXACT and BASE over the pieces of evidence, so a rival fitting the same pieces with only BASE fits
 * (half of EXACT) still comes close, and an equal score, a tie, always does.
 */
const COMES_CLOSE_RATIO = 0.5;
/** Suggestions offered with an Unsorted disc. */
const MAX_SUGGESTIONS = 3;

/** `Vol.1-6`, `Disc 1~4`, `第1-12巻`-like folder notes: the release's disc count. */
const RELEASE_COUNT = /(?:\bvol(?:ume)?|\bdis[ck]|\bbd)\.?\s*0*1\s*[-~〜]\s*0*(\d{1,2})\b/i;
const JAPANESE_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const JAPANESE_RELEASE = /\[BDMV\]|\bJPN\b/i;

/** The parent folder path of the disc folder or ISO. */
export function groupKey(e: DiscEvidence): string {
  const cut = e.path.lastIndexOf('/');
  return cut < 0 ? '' : e.path.slice(0, cut);
}

/** One name the evidence carries: a disc title, a folder segment or a TheDiscDB hit, and what lookups found for it. */
interface Piece {
  readonly kind: Via;
  readonly parse: ParsedName;
  readonly found: Entry[];
  readonly hit?: DiscDbHit;
}

interface Scored {
  readonly entry: Entry;
  readonly score: number;
  readonly exact: boolean;
  readonly kinds: ReadonlySet<Via>;
  readonly compat: Compat;
}

type Compat = { readonly ok: true; readonly season: number | null } | { readonly ok: false; readonly unresolved: boolean };

/** A disc that passed rules 1-3, waiting for rule 4 (its place among its siblings). */
interface Pending {
  readonly e: DiscEvidence;
  readonly entry: Entry;
  readonly season: number | null;
  readonly disc: number | null;
  readonly bonus: boolean;
  readonly via: readonly Via[];
}

const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export async function matchDiscs(evidence: readonly DiscEvidence[], ctx: MatchContext): Promise<{ matches: DiscMatch[]; entries: Map<string, Entry> }> {
  const groups = new Map<string, DiscEvidence[]>();
  for (const e of evidence) {
    const key = groupKey(e);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const byDisc = new Map<string, DiscMatch>();
  const entries = new Map<string, Entry>();
  for (const discs of groups.values()) {
    const lookup: DiscEvidence[] = [];
    for (const e of discs) {
      const music = musicRelease(e);
      if (music) byDisc.set(e.discId, { discId: e.discId, status: 'music', group: music, name: lastSegment(music) });
      else lookup.push(e);
    }
    if (lookup.length === 0) continue;
    try {
      for (const m of await matchGroup(lookup, ctx, entries)) byDisc.set(m.discId, m);
    } catch (err) {
      if (!(err instanceof SourceUnavailable)) throw err;
      for (const e of lookup) byDisc.set(e.discId, { discId: e.discId, status: 'unsorted', reason: 'source-unreachable', suggestions: [] });
    }
  }
  return { matches: evidence.map((e) => byDisc.get(e.discId)!), entries };
}

/**
 * The release folder of a music disc, or null when the disc isn't music: the deepest segment whose name shows a CD-plus-BD
 * release, else, under a `Music` folder, the disc's parent folder (or the disc folder itself when its parent is `Music`).
 */
function musicRelease(e: DiscEvidence): string | null {
  const segs = e.segments;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (parseName(segs[i]!).music) return segs.slice(0, i + 1).join('/');
  }
  const underMusic = segs.slice(0, -1).some((s) => s.trim().toLowerCase() === 'music');
  if (!underMusic && !e.discTitles.some((t) => parseName(t.name).music)) return null;
  const parent = segs.length - 2;
  const parentIsShelf = parent < 0 || segs[parent]!.trim().toLowerCase() === 'music';
  return segs.slice(0, parentIsShelf ? segs.length : segs.length - 1).join('/');
}

async function matchGroup(discs: readonly DiscEvidence[], ctx: MatchContext, entries: Map<string, Entry>): Promise<DiscMatch[]> {
  // Japanese text, a Japanese release pattern or a Japanese label: AniList first; otherwise TMDB first (spec §7)
  const japanese = discs.some((e) =>
    e.segments.some((s) => JAPANESE_TEXT.test(s) || JAPANESE_RELEASE.test(s)) ||
    e.discTitles.some((t) => t.lang.toLowerCase() === 'jpn' || JAPANESE_TEXT.test(t.name)));
  const sources: [string, MetadataSource][] = [];
  if (japanese) sources.push(['anilist', ctx.anilist]);
  if (ctx.tmdb) sources.push(['tmdb', ctx.tmdb]);
  if (!japanese) sources.push(['anilist', ctx.anilist]);

  const search = async (source: string, src: MetadataSource, query: string, year: number | null): Promise<Entry[]> => {
    const key = `${source}:${normalizeTitle(query)}${year === null ? '' : `:${year}`}`;
    let hit = ctx.cache.get(key);
    if (!hit) {
      hit = await src.search(query, year === null ? undefined : { year });
      ctx.cache.set(key, hit);
    }
    return hit;
  };
  /** Every candidate of a parse, on the first source, then on the other unless the first gave an exact fit. */
  const lookUp = async (parse: ParsedName): Promise<Entry[]> => {
    const found: Entry[] = [];
    for (const cand of parse.candidates) {
      if (normalizeTitle(cand) === '') continue;
      for (const [name, src] of sources) {
        const list = await search(name, src, cand, parse.year);
        found.push(...list);
        if (list.some((en) => quality(en, cand, parse.season) === EXACT)) break;
      }
    }
    return found;
  };

  // folders above the discs, from the group folder up to the first one that names something
  const above = discs[0]!.segments.slice(0, -1);
  const ancestors: Piece[] = [];
  const ancestorText: string[] = [];
  for (let i = above.length - 1; i >= 0; i--) {
    const parse = parseName(above[i]!);
    const found = await lookUp(parse);
    ancestors.push({ kind: 'folder', parse, found });
    ancestorText.push(above[i]!.normalize('NFKC'));
    if (found.some((en) => parse.candidates.some((c) => quality(en, c, parse.season) > 0))) break;
  }
  const releaseCount = ancestorText.map((t) => RELEASE_COUNT.exec(t)?.[1]).find((n) => n !== undefined);

  const out = new Map<string, DiscMatch>();
  const pending: Pending[] = [];
  for (const e of discs) {
    const own: Piece[] = [];
    for (const t of e.discTitles) {
      const parse = parseName(t.name);
      own.push({ kind: 'disc-title', parse, found: await lookUp(parse) });
    }
    const segParse = parseName(e.segments[e.segments.length - 1] ?? '');
    own.push({ kind: 'folder', parse: segParse, found: await lookUp(segParse) });
    const named = [...own, ...ancestors];

    const hit = e.fingerprint ? ctx.discdb.lookup(e.fingerprint) : null;
    const pieces = [...named];
    if (hit) {
      // TheDiscDB's title is looked up only when nothing else names an entry: it confirms, or stands unopposed
      const parse = parseName(hit.title);
      const nothingElse = !named.some((p) => p.found.some((en) => fit(p, en, null) > 0));
      pieces.push({ kind: 'discdb', parse, hit, found: nothingElse ? await lookUp(parse) : [] });
    }

    const result = decide(e, own, pieces, hit, entries);
    if ('status' in result) out.set(e.discId, result);
    else pending.push(result);
  }

  // rule 4: the disc's place, from its own number or its order among siblings filed under the same entry and season
  for (const p of pending) {
    const siblings = pending.filter((q) => !q.bonus && q.entry.id === p.entry.id && q.season === p.season).sort((a, b) => naturalOrder(a.e.path, b.e.path));
    let disc = p.disc;
    let placed = disc !== null || p.bonus || (p.entry.kind === 'movie' && siblings.length === 1);
    if (!placed && releaseCount !== undefined && Number(releaseCount) === siblings.length && siblings.every((q) => q.disc === null)) {
      disc = siblings.indexOf(p) + 1;
      placed = true;
    }
    entries.set(p.entry.id, p.entry);
    out.set(p.e.discId, placed
      ? { discId: p.e.discId, status: 'filed', entryId: p.entry.id, season: p.season, disc, bonus: p.bonus, via: p.via }
      : { discId: p.e.discId, status: 'unsorted', reason: 'no-disc-number', suggestions: [p.entry.id] });
  }
  return discs.map((e) => out.get(e.discId)!);
}

/** Rules 1-3 for one disc: an Unsorted match, or the entry and season waiting for rule 4. */
function decide(e: DiscEvidence, own: readonly Piece[], pieces: readonly Piece[], hit: DiscDbHit | null, entries: Map<string, Entry>): DiscMatch | Pending {
  const unsorted = (reason: UnsortedReason, suggest: readonly Entry[]): DiscMatch => {
    const ids = [...new Set(suggest.map((en) => en.id))].slice(0, MAX_SUGGESTIONS);
    for (const en of suggest) if (ids.includes(en.id)) entries.set(en.id, en);
    return { discId: e.discId, status: 'unsorted', reason, suggestions: ids };
  };

  const seasonsSeen = new Set<number>();
  for (const p of pieces) if (p.parse.season !== null && p.kind !== 'discdb') seasonsSeen.add(p.parse.season);
  if (hit?.season != null) seasonsSeen.add(hit.season);
  const evSeason: number | null | 'conflict' = seasonsSeen.size > 1 ? 'conflict' : seasonsSeen.size === 1 ? [...seasonsSeen][0]! : null;
  const fitSeason = evSeason === 'conflict' ? null : evSeason;

  const candidates = new Map<string, Entry>();
  for (const p of pieces) for (const en of p.found) candidates.set(en.id, en);
  const scored: Scored[] = [];
  for (const en of candidates.values()) {
    let score = 0;
    let exact = false;
    const kinds = new Set<Via>();
    for (const p of pieces) {
      const q = fit(p, en, fitSeason);
      if (q === 0) continue;
      score += q;
      exact ||= q === EXACT;
      kinds.add(p.kind);
    }
    if (score > 0) scored.push({ entry: en, score, exact, kinds, compat: compatible(en, evSeason) });
  }
  const fitting = scored.filter((s) => s.compat.ok || s.compat.unresolved).sort((a, b) => b.score - a.score);
  if (fitting.length === 0) {
    // titles fit, but every one contradicts the evidence's season
    return scored.length > 0 ? unsorted('no-season', scored.map((s) => s.entry)) : unsorted('no-title', []);
  }
  const best = fitting[0]!;
  const fittingIds = new Set(fitting.map((s) => s.entry.id));
  const ranked = fitting.map((s) => s.entry);

  // two pieces of evidence naming different entries is a disagreement, never a pick (ruling T5b); a TheDiscDB hit
  // that names none of the entries found counts too
  const disagree = pieces.some((p) => {
    const fits = [...candidates.values()].filter((en) => fittingIds.has(en.id) && fit(p, en, fitSeason) > 0);
    return fits.length > 0 ? !fits.includes(best.entry) : p.kind === 'discdb';
  });
  if (disagree) return unsorted('sources-disagree', ranked);
  // rule 1: exactly one entry fits, with an exact fit, and no other comes close
  if (fitting.slice(1).some((s) => s.score >= best.score * COMES_CLOSE_RATIO)) return unsorted('several-fit', ranked);
  // rule 2: two independent kinds of evidence agree, or one exact match has no competitor at all
  const competitor = fitting.length > 1;
  if (!best.exact || (best.kinds.size < 2 && competitor)) return unsorted(competitor ? 'several-fit' : 'no-season', ranked);

  const bonus = pieces.some((p) => p.kind !== 'discdb' && p.parse.bonus);
  // rule 3: the season or movie is resolved; a bonus disc without a season goes to the title's extras
  if (!best.compat.ok && !bonus) return unsorted('no-season', [best.entry]);
  const season = best.compat.ok ? best.compat.season : null;
  const episodes = pieces.find((p) => p.kind !== 'discdb' && p.parse.episodes !== null)?.parse.episodes ?? null;
  const count = episodeCount(best.entry, season);
  if (!bonus && episodes !== null && count !== null && episodes[1] > count) return unsorted('episode-past-season', [best.entry]);

  const numbers = new Set(own.map((p) => p.parse.volume ?? p.parse.disc).filter((n): n is number => n !== null));
  const via = (['disc-title', 'folder', 'discdb'] as const).filter((k) => best.kinds.has(k));
  return { e, entry: best.entry, season, disc: numbers.size === 1 ? [...numbers][0]! : null, bonus, via };
}

/** The best fit of any of a piece's candidates; a TheDiscDB hit also fits the TMDB entry it names. */
function fit(p: Piece, en: Entry, season: number | null): number {
  if (p.hit?.tmdbId && en.id === `tmdb-${p.hit.kind === 'series' ? 'tv' : 'movie'}:${p.hit.tmdbId}`) return EXACT;
  let best = 0;
  p.parse.candidates.forEach((cand, i) => {
    const q = quality(en, cand, season);
    best = Math.max(best, i === 0 ? q : Math.min(q, LATER_CANDIDATE_MAX));
  });
  return best;
}

function names(en: Entry): string[] {
  return [en.names.english, en.names.romaji, en.names.native, ...en.names.synonyms].filter((n): n is string => n !== null && n.trim() !== '');
}

/** EXACT, BASE or 0: see the constants. */
function quality(en: Entry, candidate: string, season: number | null): number {
  const c = normalizeTitle(candidate);
  if (c === '') return 0;
  let q = 0;
  for (const name of names(en)) {
    if (normalizeTitle(name) === c) return EXACT;
    const parsed = parseName(name);
    const base = parsed.candidates[0];
    if (base === undefined || normalizeTitle(base) !== c) continue;
    if (parsed.season !== null && parsed.season === season) return EXACT;
    q = BASE;
  }
  return q;
}

/** An AniList entry's season within its franchise: from its names, else 1 when it has no prequel, else unknown. */
function anilistPlace(en: Entry): number | null {
  const seen = new Set(names(en).map((n) => parseName(n).season).filter((s): s is number => s !== null));
  if (seen.size === 1) return [...seen][0]!;
  if (seen.size > 1) return null;
  return en.relations.some((r) => r.type === 'PREQUEL') ? null : 1;
}

/** Whether an entry can be the evidence's season (rule 3), and which season it files under. */
function compatible(en: Entry, evSeason: number | null | 'conflict'): Compat {
  if (evSeason === 'conflict') return { ok: false, unresolved: true };
  if (en.kind === 'movie') return evSeason === null ? { ok: true, season: null } : { ok: false, unresolved: false };
  if (en.source === 'anilist') {
    const place = anilistPlace(en);
    if (evSeason === null) return { ok: true, season: place };
    if (place === null) return { ok: false, unresolved: true };
    return place === evSeason ? { ok: true, season: place } : { ok: false, unresolved: false };
  }
  if (evSeason !== null) return en.seasons.some((s) => s.number === evSeason) ? { ok: true, season: evSeason } : { ok: false, unresolved: false };
  return en.seasons.length === 1 ? { ok: true, season: en.seasons[0]!.number } : { ok: false, unresolved: true };
}

function episodeCount(en: Entry, season: number | null): number | null {
  if (en.kind === 'movie') return null;
  if (en.source === 'anilist') return en.episodes;
  return en.seasons.find((s) => s.number === season)?.episodes ?? null;
}
