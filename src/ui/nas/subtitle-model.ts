import type { StoredSubtitle } from '../../engine/disc/nas-api';

/** The server's limits (`server/src/subtitle-store.ts`), shown here so a pick is refused before it uploads. */
export const SUBTITLE_LIMIT_BYTES = 5 * 1024 * 1024;
export const FONTS_LIMIT_BYTES = 50 * 1024 * 1024;

/** The languages the upload form offers; any other BCP 47 tag may be typed. */
export const LANGUAGES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh-Hans', label: 'Chinese (Simplified)' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)' },
  { code: 'ko', label: 'Korean' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
];

const SUBTITLE_EXT = /\.(?:srt|ass|ssa)$/i;
const FONT_EXT = /\.(?:ttf|otf|ttc|woff2?)$/i;

/** One subtitle file with its fonts, or why the pick can't be uploaded. */
export function validateUpload(files: readonly File[]): { subtitle: File; fonts: File[] } | { error: string } {
  const subtitles = files.filter((f) => SUBTITLE_EXT.test(f.name));
  const fonts = files.filter((f) => FONT_EXT.test(f.name));
  const other = files.find((f) => !SUBTITLE_EXT.test(f.name) && !FONT_EXT.test(f.name));
  if (other) return { error: `${other.name} is neither a subtitle file nor a font.` };
  if (subtitles.length === 0) return { error: 'Pick a subtitle file (SRT, ASS or SSA).' };
  if (subtitles.length > 1) return { error: 'Pick one subtitle file (SRT or ASS) at a time.' };
  const subtitle = subtitles[0];
  if (subtitle.size === 0) return { error: `${subtitle.name} is empty.` };
  if (subtitle.size > SUBTITLE_LIMIT_BYTES) return { error: `${subtitle.name} is over 5 MB.` };
  if (fonts.reduce((n, f) => n + f.size, 0) > FONTS_LIMIT_BYTES) return { error: 'The fonts are over 50 MB together.' };
  return { subtitle, fonts };
}

/** Episode number to the languages stored for it in a season, sorted and without repeats. */
export function tagsByEpisode(subs: readonly StoredSubtitle[], seasonId: string): Map<number, string[]> {
  const sets = new Map<number, Set<string>>();
  for (const s of subs) {
    if (s.attachment.kind !== 'episode' || s.attachment.seasonId !== seasonId) continue;
    const set = sets.get(s.attachment.episode) ?? new Set<string>();
    set.add(s.language);
    sets.set(s.attachment.episode, set);
  }
  return new Map([...sets].map(([episode, set]) => [episode, [...set].sort()]));
}

/** The subtitles stored for one playlist of a disc. */
export function forPlaylist(subs: readonly StoredSubtitle[], discKey: string, playlistId: string): StoredSubtitle[] {
  return subs.filter((s) => s.attachment.discKey === discKey && s.attachment.playlistId === playlistId);
}

/** Where a stored subtitle is placed, in playlist microseconds: an episode's at 0, a chapter's at its start; null when that chapter doesn't exist. */
export function startFor(s: StoredSubtitle, chapters: readonly { readonly startUs: number }[]): number | null {
  if (s.attachment.kind === 'episode') return 0;
  return chapters[s.attachment.chapter]?.startUs ?? null;
}

/** The first subtitle in a language (compared without case), or null. */
export function sameLanguage(subs: readonly StoredSubtitle[], language: string): StoredSubtitle | null {
  const wanted = language.toLowerCase();
  return subs.find((s) => s.language.toLowerCase() === wanted) ?? null;
}
