/** Which episode a release's file name holds, and a movie's main file. Pure; original code. */
import type { ToshoFile } from './tosho';

const EXTRA_WORD = /\b(NC(OP|ED)\d*|OP\d*|ED\d*|PV|CM|Preview|Menu|Extras?|SP\d*|OVA)\b/i;
const EXTRA_DIRS = new Set(['extras', 'bonus', 'nc', 'specials']);

/** Patterns in order of confidence; each captures the episode number. */
const PATTERNS: readonly RegExp[] = [
  /S\d{1,2}E(\d{1,3})(?!\d)/i,
  /(?:^|[^A-Za-z])E(\d{2,3})(?!\d)/,
  /第\s*(\d{1,3})\s*話/,
  / - (\d{1,3})(?:v\d+)?(?=[\s.[(]|$)/,
  /(?:^|[\s_.])(\d{2,3})v\d+(?=[\s.[(_]|$)/,
  / (\d{1,3})(?:v\d+)? (?=[[(])/,
];

function split(name: string): { dirs: string[]; base: string } {
  const parts = name.split(/[\\/]/);
  return { dirs: parts.slice(0, -1), base: parts[parts.length - 1] ?? '' };
}

/** True for creditless openings and endings, previews, menus and anything under an extras folder. */
export function isExtraFile(name: string): boolean {
  const { dirs, base } = split(name);
  return dirs.some((d) => EXTRA_DIRS.has(d.trim().toLowerCase())) || EXTRA_WORD.test(base);
}

export function episodeOfFile(name: string): number | null {
  if (isExtraFile(name)) return null;
  const base = split(name).base.replace(/\.[A-Za-z0-9]{2,4}$/, '');
  for (const p of PATTERNS) {
    const m = p.exec(base);
    if (m) {
      const n = Number(m[1]);
      if (n > 0) return n;
    }
  }
  return null;
}

/** The file's number as this season's number (`before` = episodes in the earlier seasons), or null. */
export function seasonEpisode(fileEpisode: number, season: { readonly count: number; readonly before: number }): number | null {
  if (fileEpisode >= 1 && fileEpisode <= season.count) return fileEpisode;
  const n = fileEpisode - season.before;
  return n >= 1 && n <= season.count ? n : null;
}

/** A movie's file: the largest that is not an extra. */
export function mainFile(files: readonly ToshoFile[]): ToshoFile | null {
  let best: ToshoFile | null = null;
  for (const f of files) if (!isExtraFile(f.name) && (best === null || f.size > best.size)) best = f;
  return best;
}
