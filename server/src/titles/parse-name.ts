/**
 * Name parsing (spec §7): turns a folder name or a disc title into candidate titles plus the season, volume, disc, box,
 * year, episodes, bonus and music markers it carries. Original code; the corpus in corpus.ts pins its behaviour.
 */

export interface ParsedName {
  readonly candidates: readonly string[]; // title strings left after stripping, best first; `English (日本語)` gives both
  readonly season: number | null;
  readonly volume: number | null; // Vol./Volume/巻/上巻=1/下巻=2
  readonly disc: number | null; // Disc/D/DISC
  readonly box: number | null;
  readonly year: number | null;
  readonly episodes: readonly [number, number] | null;
  readonly bonus: boolean;
  readonly music: boolean; // [CD] or FLAC together with BDMV; an artist – title pattern under a Music folder is the grouping's call
}

type Structure = { -readonly [K in keyof Omit<ParsedName, 'candidates'>]: ParsedName[K] };

/** Where a stripped token was: title text is cut here, and the first non-empty piece is the title. */
const CUT = '\u0000';

const KANJI_DIGITS: Readonly<Record<string, number>> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** An ASCII number, or a kanji one up to 99 (`八`, `十二`, `二十`). */
const NUM = '(\\d{1,3}|[一二三四五六七八九十]{1,3})';

function toNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const [tens, ones] = text.split('十');
  if (ones === undefined) return KANJI_DIGITS[text] ?? Number.NaN;
  return (tens === '' ? 1 : (KANJI_DIGITS[tens ?? ''] ?? Number.NaN)) * 10 + (ones === '' ? 0 : (KANJI_DIGITS[ones] ?? Number.NaN));
}

type Field = 'season' | 'volume' | 'disc' | 'box';
const set = (s: Structure, field: Field, text: string | undefined): void => {
  const n = toNumber(text ?? '');
  if (s[field] === null && Number.isFinite(n)) s[field] = n;
};

/**
 * Structure tokens, in the order they are tried. Each is replaced by a cut, so the title is the text before it.
 * Ranges come before single numbers, and `2nd Season` before `Season 2`.
 */
const STRUCTURE: readonly { readonly re: RegExp; readonly read: (s: Structure, m: string[]) => void }[] = [
  // a volume range names a box or series folder, not one volume
  { re: /\bVol(?:ume)?\.?[ ._]*\d{1,3}\s*[-~]\s*(?:Vol(?:ume)?\.?[ ._]*)?\d{1,3}\b/gi, read: () => {} },
  { re: /第(\d{1,4})話?\s*[-~]\s*第?(\d{1,4})話/g, read: (s, m) => { s.episodes ??= [Number(m[1]), Number(m[2])]; } },
  { re: /第(\d{1,4})話/g, read: (s, m) => { s.episodes ??= [Number(m[1]), Number(m[1])]; } },
  { re: /\bS(\d{1,2})(?:E\d{1,3})?\b/gi, read: (s, m) => set(s, 'season', m[1]) },
  { re: /\b(\d{1,2})(?:st|nd|rd|th)[ ._]*Season\b/gi, read: (s, m) => set(s, 'season', m[1]) },
  { re: /\bSeason[ ._]*(\d{1,2})\b/gi, read: (s, m) => set(s, 'season', m[1]) },
  { re: new RegExp(`第${NUM}(?:期|シリーズ)`, 'g'), read: (s, m) => set(s, 'season', m[1]) },
  { re: /\bVol(?:ume)?\.?[ ._]*(\d{1,3})\b/gi, read: (s, m) => set(s, 'volume', m[1]) },
  { re: new RegExp(`第?${NUM}巻`, 'g'), read: (s, m) => set(s, 'volume', m[1]) },
  { re: /上巻/g, read: (s) => set(s, 'volume', '1') },
  { re: /下巻/g, read: (s) => set(s, 'volume', '2') },
  { re: /\bDis[ck][ ._]*(\d{1,2})\b/gi, read: (s, m) => set(s, 'disc', m[1]) },
  { re: /ディスク(\d{1,2})/g, read: (s, m) => set(s, 'disc', m[1]) },
  { re: /\bD(\d{1,2})\b/g, read: (s, m) => set(s, 'disc', m[1]) },
  { re: /\bBOX[ ._]*(\d{1,2})\b/gi, read: (s, m) => set(s, 'box', m[1]) },
];

/** Bonus markers that are never part of a title, so they cut it. */
const BONUS_CUT = /映像特典|特典(?:DISC|ディスク)?|\bBonus\b/gi;
/** Bonus markers that can also be title words, so they only set the flag. */
const BONUS_WORD = /\b(?:Event|Live)\b/i;

/** Release, format, codec and region tokens: they end a title wherever they appear. */
const TECH = new RegExp(
  [
    '\\d{3,4}[pi]', '4K', 'UHD', 'Blu-?ray', 'BDRip', 'BDMV', 'BD', 'DVD', 'ISO', 'REMUX', 'AVC', 'HEVC', 'H\\.?26[45]', 'x26[45]',
    'MPEG-?2', 'VC-?1', 'LPCM', 'PCM', 'FLAC', 'AAC', 'AC-?3', 'E-?AC-?3', 'DTS(?:-HD)?(?:[ .]MA)?', 'TrueHD', 'Atmos', 'HDR(?:10)?',
    'JPN', 'USA', 'ITA', 'ENG', 'GER', 'FRA', 'ESP', 'KOR', 'CHN', 'BOX', 'Fin',
  ].map((t) => `\\b${t}\\b`).join('|') + '|初回(?:生産)?限定版|完全生産限定版|通常版',
  'gi',
);
/** Tags that only count inside brackets, since outside them they may be title words. */
const BRACKET_TAG = /^(?:CD|CUE|LOG|BK|SCANS?|WAV|MP3|アニメ|映画|ドラマ|Anime|Movie)$/i;
const WHOLE_TECH = new RegExp(`^(?:${TECH.source})$`, 'i');
const TECH_START = new RegExp(`^\\s*(?:${TECH.source})`, 'i');
/** `ABCD-12345`, `XXCL-1234~5`. */
const CATALOGUE = /\b[A-Z]{2,5}-\d{3,5}(?:~\d{1,2})?\b/g;
/** `2025.03.26`, `2025-03-26`. */
const DATE = /\b(?:19|20)\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}\b/g;
const TRIM = /^[\s\-–—:~_.,・/|+&]+|[\s\-–—:~_.,・/|+&]+$/g;
const CJK_END = /^(.*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(\d{1,2})$/u;

/** Strips structure and tags from free text, recording what it finds, and returns the title piece left (or ''). */
function scan(text: string, s: Structure, scene: boolean): string {
  let t = text.replace(DATE, CUT).replace(CATALOGUE, CUT);
  if (scene) {
    // `Title.2025.2160p…`: a year token after the title and before the release tokens
    t = t.replace(/(?<=\S\s)((?:19|20)\d{2})(?=\s+\S|\s*$)/, (y, _g, offset: number) => {
      const rest = t.slice(offset + y.length);
      if (rest.trim() !== '' && !TECH_START.test(rest)) return y;
      s.year ??= Number(y);
      return CUT;
    });
  }
  for (const { re, read } of STRUCTURE) t = t.replace(re, (...m: string[]) => (read(s, m), CUT));
  t = t.replace(BONUS_CUT, () => ((s.bonus = true), CUT)).replace(TECH, CUT);
  for (const piece of t.split(CUT)) {
    const clean = piece.replace(/\s+/g, ' ').replace(TRIM, '');
    if (/[\p{L}\p{N}]/u.test(clean)) return clean;
  }
  return '';
}

/** A bracketed or parenthesised group's content: a tag, a date, a year, an episode range, or title text. */
function scanGroup(content: string, s: Structure, paren: boolean): string {
  const c = content.trim();
  if (/^\d{6}$|^\d{8}$/.test(c)) return '';
  const year = /^((?:19|20)\d{2})$/.exec(c);
  if (year) {
    s.year ??= Number(year[1]);
    return '';
  }
  const range = paren ? /^(\d{1,4})\s*[-~]\s*(\d{1,4})$/.exec(c) : null;
  if (range) {
    s.episodes ??= [Number(range[1]), Number(range[2])];
    return '';
  }
  if (c.split(/[+\s,/]+/).every((tag) => tag === '' || BRACKET_TAG.test(tag) || WHOLE_TECH.test(tag))) return '';
  return scan(c, s, false);
}

export function parseName(text: string): ParsedName {
  const s: Structure = { season: null, volume: null, disc: null, box: null, year: null, episodes: null, bonus: false, music: false };
  const nfkc = text.normalize('NFKC');
  s.music = /\[CD\]/i.test(nfkc) || (/\bFLAC\b/i.test(nfkc) && /\bBDMV\b/i.test(nfkc));
  if (BONUS_WORD.test(nfkc)) s.bonus = true;

  const brackets: string[] = [];
  const parens: string[] = [];
  let outside = nfkc
    .replace(/\[([^[\]]*)\]|【([^】]*)】/g, (_m, a?: string, b?: string) => (brackets.push(a ?? b ?? ''), CUT))
    .replace(/\(([^()]*)\)/g, (_m, a: string) => (parens.push(a), CUT));
  // scene names separate words with dots or underscores and have no spaces
  const scene = !/\s/.test(outside) && /[._]/.test(outside);
  if (scene) outside = outside.replace(/[._]/g, ' ');

  const found = [
    ...outside.split(CUT).map((piece) => scan(piece, s, scene)).filter((c) => c !== '').slice(0, 1),
    ...brackets.map((g) => scanGroup(g, s, false)),
    ...parens.map((g) => scanGroup(g, s, true)),
  ];
  const candidates = [...new Set(found.filter((c) => c !== ''))];

  // a disc title like `星降りの旅人 2` ends in its volume
  const first = candidates[0];
  const tail = first === undefined || s.volume !== null || s.disc !== null ? null : CJK_END.exec(first);
  if (tail) {
    candidates[0] = tail[1] ?? first ?? '';
    s.volume = Number(tail[2]);
  }
  return { candidates, ...s };
}
