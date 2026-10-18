import { readFile, stat } from 'node:fs/promises';
import { MarkType, parseMpls } from '../../../src/engine/bdmv/mpls-parser';
import { contentHash } from '../../../src/engine/disc/content-hash';
import type { DiscEntry } from '../../../src/engine/disc/nas-api';
import type { UdfFile } from '../../../src/engine/disc/udf';
import { readIsoFiles } from '../iso';
import { listFiles } from '../manifest';

/** What a disc's files and path say about it, read once per new or changed disc for the title matcher. */
export interface DiscEvidence {
  readonly discId: string;
  readonly path: string; // root-relative, as DiscEntry.path
  readonly fingerprint: string | null; // contentHash
  readonly discTitles: readonly { readonly lang: string; readonly name: string }[]; // bdmt di:name per language
  readonly segments: readonly string[]; // folder names from below the root down to the disc folder or ISO file name
  readonly catalogueNumbers: readonly string[];
  readonly playlists: readonly { readonly id: string; readonly durationS: number; readonly chapters: number; readonly clips: readonly string[] }[];
}

const STREAM = /^BDMV\/STREAM\/([^/]+\.M2TS)$/;
const PLAYLIST = /^BDMV\/PLAYLIST\/([^/]+)\.MPLS$/;
const BDMT = /^BDMV\/META\/DL\/BDMT_([A-Z]{3})\.XML$/;
/** Larger metadata or playlist files than this are not read. */
const MAX_READ_BYTES = 1024 * 1024;

/** Letter groups that look like a catalogue number's prefix but name a format or a volume. */
const NOT_CATALOGUE = new Set(['AAC', 'AC', 'AVC', 'BD', 'BDMV', 'BDRIP', 'CD', 'DISC', 'DTS', 'DVD', 'EP', 'FHD', 'FLAC', 'HD', 'HDR', 'HEVC', 'ISO', 'LPCM', 'MKV', 'OVA', 'PCM', 'SDR', 'SP', 'TV', 'UHD', 'VOL']);
const CATALOGUE = /(?<![A-Za-z0-9])([A-Z]{2,5})[- ](\d{3,5})(?![0-9A-Za-z])/g;

/** The catalogue numbers in `text`, normalized to `PREFIX-NUMBER` ('MNOP 1357' → 'MNOP-1357', 'XXCL-1234~5' → 'XXCL-1234'). */
export function catalogueNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.normalize('NFKC').matchAll(CATALOGUE)) if (!NOT_CATALOGUE.has(m[1]!)) found.add(`${m[1]}-${m[2]}`);
  return [...found];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The text of the first `<di:name>` in a bdmt file, entities decoded and whitespace trimmed. */
function bdmtName(xml: string): string | null {
  const m = /<di:name(?:\s[^>]*)?>([\s\S]*?)<\/di:name>/.exec(xml);
  if (!m) return null;
  const name = m[1]!
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, e: string) => {
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITIES[e] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return name === '' ? null : name;
}

/** A playlist's duration (sum of its play items) in seconds, to the millisecond, its entry marks and its clips. */
function playlistOf(id: string, bytes: Uint8Array): DiscEvidence['playlists'][number] | null {
  try {
    const mpls = parseMpls(bytes);
    const ticks = mpls.playItems.reduce((sum, item) => sum + Math.max(0, item.outTime - item.inTime), 0);
    return {
      id,
      durationS: Math.round(ticks / 45) / 1000,
      chapters: mpls.marks.filter((m) => m.type === MarkType.ENTRY).length,
      clips: mpls.playItems.map((item) => item.clipId),
    };
  } catch {
    return null; // Not a playlist this parser reads: left out.
  }
}

/**
 * The evidence of a disc whose files (upper-cased disc-relative paths with sizes) are `files`; `read` returns the
 * bytes of those asked for, leaving out any it couldn't read.
 */
async function evidenceOf<F extends { path: string; size: number }>(
  entry: DiscEntry,
  files: readonly F[],
  read: (files: F[]) => Promise<Map<string, Uint8Array>>,
): Promise<DiscEvidence> {
  const streams = files.flatMap((f) => {
    const m = STREAM.exec(f.path);
    return m ? [{ name: m[1]!, size: f.size }] : [];
  });
  const wanted = files.filter((f) => f.size <= MAX_READ_BYTES && (PLAYLIST.test(f.path) || BDMT.test(f.path)));
  const bytes = await read(wanted);
  const discTitles: { lang: string; name: string }[] = [];
  const playlists: DiscEvidence['playlists'][number][] = [];
  for (const f of wanted) {
    const b = bytes.get(f.path);
    if (!b) continue;
    const bdmt = BDMT.exec(f.path);
    const pl = PLAYLIST.exec(f.path);
    if (bdmt) {
      const name = bdmtName(new TextDecoder().decode(b));
      if (name) discTitles.push({ lang: bdmt[1]!.toLowerCase(), name });
    } else if (pl) {
      const playlist = playlistOf(pl[1]!, b);
      if (playlist) playlists.push(playlist);
    }
  }
  discTitles.sort((a, b) => (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0));
  playlists.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const segments = entry.path.split('/').slice(1);
  const catalogue = new Set([...segments, ...discTitles.map((t) => t.name)].flatMap(catalogueNumbers));
  return { discId: entry.id, path: entry.path, fingerprint: contentHash(streams), discTitles, segments, catalogueNumbers: [...catalogue], playlists };
}

/** The evidence of the folder disc `entry` at `dir`. */
export async function readFolderEvidence(entry: DiscEntry, dir: string): Promise<DiscEvidence> {
  const listed = await listFiles(dir);
  const sized = await Promise.all(
    listed.map(async (f) => {
      if (!STREAM.test(f.path) && !PLAYLIST.test(f.path) && !BDMT.test(f.path)) return null;
      try {
        return { ...f, size: (await stat(f.abs)).size };
      } catch {
        return null; // Vanished meanwhile.
      }
    }),
  );
  const files = sized.filter((f): f is { path: string; abs: string; size: number } => f !== null);
  return evidenceOf(entry, files, async (wanted) => {
    const out = new Map<string, Uint8Array>();
    for (const f of wanted) {
      try {
        out.set(f.path, await readFile(f.abs));
      } catch {
        // Left out.
      }
    }
    return out;
  });
}

/** The evidence of the ISO disc `entry` at `abs`, whose UDF tree is `tree`. */
export async function readIsoEvidence(entry: DiscEntry, abs: string, tree: ReadonlyMap<string, UdfFile>): Promise<DiscEvidence> {
  return evidenceOf(entry, [...tree.values()], (wanted) => readIsoFiles(abs, wanted));
}
