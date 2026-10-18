/** What a metadata source (AniList, TMDB) knows about one series or film. */

export type SourceName = 'anilist' | 'tmdb';

export interface EntryNames {
  readonly english: string | null;
  readonly romaji: string | null;
  readonly native: string | null;
  readonly synonyms: readonly string[];
}

export interface Entry {
  readonly source: SourceName;
  readonly id: string; // 'anilist:154587', 'tmdb-tv:65930', 'tmdb-movie:12345'
  readonly kind: 'series' | 'movie';
  readonly format: string | null; // AniList TV/TV_SHORT/MOVIE/OVA/ONA/SPECIAL
  readonly names: EntryNames;
  /** Animated: TMDB's Animation genre (16), null when TMDB gave no genres; always true on AniList. */
  readonly animation: boolean | null;
  readonly year: number | null;
  readonly episodes: number | null;
  readonly runtimeMin: number | null;
  /** TMDB TV only, numbered from 1: season 0 (TMDB's "Specials") is left out. */
  readonly seasons: readonly { readonly number: number; readonly episodes: number; readonly runtimeMin: number | null }[];
  /** AniList only. `startDate` is AniList's FuzzyDateInt, YYYYMMDD with 00 for an unknown month or day. */
  readonly relations: readonly { readonly type: string; readonly id: string; readonly format: string | null; readonly startDate: number | null }[];
  readonly poster: { readonly small: string; readonly large: string } | null; // source URLs
  readonly banner: string | null;
}

export interface MetadataSource {
  search(query: string, opts?: { year?: number; kind?: 'series' | 'movie' }): Promise<Entry[]>;
  entry(id: string): Promise<Entry | null>;
}

/** Network errors, 429 after retries, 5xx. */
export class SourceUnavailable extends Error {
  override name = 'SourceUnavailable';
}

/** Seconds from a Retry-After header as ms, or null when it is missing or a date. */
export function retryAfterMs(header: string | null): number | null {
  if (header === null || !/^\s*\d+(\.\d+)?\s*$/.test(header)) return null;
  return Math.round(Number(header) * 1000);
}
