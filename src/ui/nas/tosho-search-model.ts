import type { ToshoReleaseFiles, ToshoSearchResult } from '../../engine/disc/nas-api';
import { languageName } from '../../player/language';

/** Spec §9's notice when a pick can't be fetched, lined up or loaded; the text set stays as it was. */
export const PICK_FAILED = "Couldn't load the subtitles from Anime Tosho.";
/** The tracks step says this while the NAS fetches and lines up a pick. */
export const LINING_UP = 'Lining up…';

export type ToshoFile = ToshoReleaseFiles['files'][number];
export type ToshoTrack = ToshoFile['tracks'][number];

/** The search box's first words: the title's display name, else the disc's name without its bracketed tags. */
export function defaultQuery(titleName: string | null, discName: string): string {
  const title = titleName?.trim() ?? '';
  if (title !== '') return title;
  const bare = discName.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return bare !== '' ? bare : discName.trim();
}

/** A release's row: its title, and a SeaDex badge when SeaDex lists it ("SeaDex best" on its best). */
export function releaseLabel(r: ToshoSearchResult): { text: string; badge: 'SeaDex best' | 'SeaDex' | null } {
  return { text: r.title, badge: r.seadex === 'best' ? 'SeaDex best' : r.seadex !== null ? 'SeaDex' : null };
}

/** A release's date (Anime Tosho's seconds), as YYYY-MM-DD in UTC. */
export function releaseDate(r: ToshoSearchResult): string {
  return new Date(r.date * 1000).toISOString().slice(0, 10);
}

const isEnglish = (language: string): boolean => {
  const l = language.trim().toLowerCase();
  return l === 'eng' || l === 'en' || l.startsWith('en-');
};

/** English first, then by language name, then by track number (a copy). */
export function sortTracks<T extends Pick<ToshoTrack, 'track' | 'language'>>(tracks: readonly T[]): T[] {
  const name = (t: T): string => languageName(t.language) || t.language;
  return [...tracks].sort((a, b) => Number(isEnglish(b.language)) - Number(isEnglish(a.language)) || name(a).localeCompare(name(b)) || a.track - b.track);
}

/** "English · Full"; the language or the name alone when the other is missing. */
export function trackLabel(t: ToshoTrack): string {
  return [languageName(t.language) || t.language.trim(), t.name.trim()].filter((s) => s !== '').join(' · ');
}

/** A file's row when no file matched the episode: its episode number, else its name. */
export function fileLabel(f: ToshoFile): string {
  return f.episode !== null ? `Episode ${f.episode}` : f.name;
}
