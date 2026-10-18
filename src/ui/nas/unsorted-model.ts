import type { OwnerChoice, TitleSummary, UnsortedReason } from '../../engine/disc/nas-api';
import { NasHttpError } from './nas-client';

/** The owner screens' words and choices (spec §9): Unsorted, its search, and filing a disc. Original code. */

export const REASON_TEXT: Readonly<Record<UnsortedReason, string>> = {
  'no-title': 'No title found',
  'several-fit': 'More than one title fits',
  'no-season': 'No season number',
  'episode-past-season': "Episode number is past the season's last",
  'no-disc-number': 'No disc number',
  'sources-disagree': 'The sources disagree',
  'source-unreachable': "AniList or TMDB couldn't be reached; it will try again",
};

/** Why the NAS left a disc in Unsorted, as the "Why unsure" line says it. */
export function reasonText(reason: UnsortedReason): string {
  return REASON_TEXT[reason];
}

/** Blu-ray.com's search for a catalogue number, opened in a new tab. */
export function blurayComSearchUrl(catalogueNumber: string): string {
  return `https://www.blu-ray.com/search/?quicksearch=1&quicksearch_keyword=${encodeURIComponent(catalogueNumber)}&section=bluraymovies`;
}

/** A disc's folder name, and the path of the folder holding it ('' at a root's top). */
export function discPlace(path: string): { name: string; parent: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { name: path, parent: '' } : { name: path.slice(cut + 1), parent: path.slice(0, cut) };
}

const KIND_LABEL = { series: 'Series', movie: 'Movie', music: 'Music' } as const;

function sourceLabel(t: TitleSummary): string {
  if (t.own) return 'Own title';
  if (t.id.startsWith('anilist:')) return 'AniList';
  if (t.id.startsWith('tmdb-')) return 'TMDB';
  return KIND_LABEL[t.kind];
}

/** A suggestion's muted line: native name · year · source; the kind stands in when there is neither name nor year. */
export function suggestionLine(t: TitleSummary): string {
  const parts = [t.names.native, t.year === null ? null : String(t.year)].filter((p): p is string => p !== null && p !== '');
  if (parts.length === 0) parts.push(KIND_LABEL[t.kind]);
  const source = sourceLabel(t);
  if (!parts.includes(source)) parts.push(source);
  return parts.join(' · ');
}

/** A season or disc field: null when blank, the number when it is a whole number from 1 to 1000, else undefined. */
export function parseNumber(text: string): number | null | undefined {
  const t = text.normalize('NFKC').trim();
  if (t === '') return null;
  if (!/^\d{1,4}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 1000 ? n : undefined;
}

/** Filing a disc under `title`: the season counts for a series only. */
export function titleChoice(title: TitleSummary, season: number | null, disc: number | null): OwnerChoice {
  return { kind: 'title', titleId: title.id, season: title.kind === 'series' ? season : null, disc };
}

/** Search results from several sources as one list, each title once, in the order found. */
export function mergeResults(lists: readonly (readonly TitleSummary[])[]): TitleSummary[] {
  const seen = new Set<string>();
  const out: TitleSummary[] = [];
  for (const list of lists) {
    for (const t of list) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** What a failed search shows (ruling T11a): refusals and unreachable sources gently, inline. */
export function lookupFailure(err: unknown): string {
  if (err instanceof NasHttpError) {
    if (err.status === 429) return `Searching too fast, try again in ${err.detail.retryAfter ?? 1} s`;
    if (err.status === 503) return "AniList or TMDB couldn't be reached";
  }
  return err instanceof Error ? err.message : String(err);
}

/** Why "Apply to the other discs" left a disc as it was (ruling T11c). */
export function skippedText(reason: 'direct' | 'copy'): string {
  return reason === 'direct' ? 'filed separately' : 'follows its copy';
}
