import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { DiscEntry, DiscManifest } from '../../src/engine/disc/nas-api';
import type { UdfFile } from '../../src/engine/disc/udf';
import { discId } from './disc-id';
import { readIsoFiles } from './iso';

/** The top-level folders of a disc that the manifest lists and the files route serves. */
const DISC_FOLDERS = new Set(['BDMV', 'CERTIFICATE']);
/** What the engine reads whole while opening a disc (`readWhole`). */
const INLINED = /^(BDMV\/(INDEX\.BDMV|MOVIEOBJECT\.BDMV|PLAYLIST\/[^/]+\.MPLS|CLIPINF\/[^/]+\.CLPI|AUXDATA\/SOUND\.BDMV|BDJO\/[^/]+\.BDJO)|CERTIFICATE\/ID\.BDMV)$/;
const MAX_INLINE_BYTES = 1024 * 1024;

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The entry of `dir` named `name` in any case, if it is a real directory or file (symlinks are never followed). */
async function child(dir: string, name: string, want: 'dir' | 'file'): Promise<string | null> {
  const upper = name.toUpperCase();
  const found = (await entries(dir))
    .filter((e) => e.name.toUpperCase() === upper && (want === 'dir' ? e.isDirectory() : e.isFile()))
    .sort((a, b) => (a.name < b.name ? -1 : 1))[0];
  return found ? join(dir, found.name) : null;
}

/**
 * Whether the folder disc `entry` at `dir` is still the one the library scanned: its index.bdmv exists and has the
 * size and mtime its id was made from.
 */
export async function discUnchanged(entry: DiscEntry, dir: string): Promise<boolean> {
  const bdmv = await child(dir, 'BDMV', 'dir');
  const index = bdmv && (await child(bdmv, 'INDEX.BDMV', 'file'));
  if (!index) return false;
  try {
    const st = await stat(index);
    return discId(entry.path, st.size, st.mtimeMs) === entry.id;
  } catch {
    return false;
  }
}

/** The segments of a disc-relative path under BDMV or CERTIFICATE, or null for any other or an odd path. */
function discSegments(path: string): string[] | null {
  const segments = path.split('/');
  if (!DISC_FOLDERS.has(segments[0]!.toUpperCase())) return null;
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) return null;
  return segments;
}

/** The file of an ISO disc's tree for a disc-relative path in any case, under BDMV or CERTIFICATE only. */
export function resolveIsoFile(tree: ReadonlyMap<string, UdfFile>, path: string): UdfFile | null {
  const segments = discSegments(path);
  return segments ? (tree.get(segments.join('/').toUpperCase()) ?? null) : null;
}

/**
 * The real file under the disc folder `dir` for a disc-relative path in any case ('BDMV/STREAM/00001.M2TS'), found by
 * listing each directory, so the path never reaches the filesystem as given. Null unless it names a regular file
 * under BDMV or CERTIFICATE.
 */
export async function resolveDiscFile(dir: string, path: string): Promise<string | null> {
  const segments = discSegments(path);
  if (!segments) return null;
  let current: string | null = dir;
  for (const [i, segment] of segments.entries()) {
    current = await child(current, segment, i === segments.length - 1 ? 'file' : 'dir');
    if (!current) return null;
  }
  return current;
}

/** Every regular file under the disc folder's BDMV and CERTIFICATE, upper-cased; on a case clash the first name wins. */
async function listFiles(dir: string): Promise<{ path: string; abs: string }[]> {
  const out = new Map<string, string>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    const sorted = (await entries(abs)).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of sorted) {
      if (e.name.startsWith('.')) continue;
      const path = rel === '' ? e.name.toUpperCase() : `${rel}/${e.name.toUpperCase()}`;
      if (rel === '' && !DISC_FOLDERS.has(path)) continue;
      if (e.isDirectory()) await walk(join(abs, e.name), path);
      else if (e.isFile() && rel !== '' && !out.has(path)) out.set(path, join(abs, e.name));
    }
  };
  await walk(dir, '');
  return [...out].map(([path, abs]) => ({ path, abs })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The manifest of the folder disc at `dir`. */
export async function buildManifest(dir: string, disc: { id: string; name: string }): Promise<DiscManifest> {
  const files: { path: string; size: number }[] = [];
  const inline: Record<string, string> = {};
  for (const { path, abs } of await listFiles(dir)) {
    let size: number;
    try {
      size = (await stat(abs)).size;
    } catch {
      continue; // Vanished meanwhile.
    }
    files.push({ path, size });
    if (INLINED.test(path) && size <= MAX_INLINE_BYTES) {
      try {
        inline[path] = (await readFile(abs)).toString('base64');
      } catch {
        // Listed without its bytes: the client reads it through the files route.
      }
    }
  }
  return { discId: disc.id, name: disc.name, files, inline };
}

/** The manifest of the ISO disc at `abs` whose UDF tree is `tree`: the same shape as a folder disc's. */
export async function buildIsoManifest(abs: string, tree: ReadonlyMap<string, UdfFile>, disc: { id: string; name: string }): Promise<DiscManifest> {
  // As for a folder disc: files under BDMV and CERTIFICATE, none hidden.
  const listed = [...tree.values()]
    .filter((f) => resolveIsoFile(tree, f.path) === f && !f.path.split('/').some((s) => s.startsWith('.')))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const bytes = await readIsoFiles(
    abs,
    listed.filter((f) => INLINED.test(f.path) && f.size <= MAX_INLINE_BYTES),
  );
  const inline: Record<string, string> = {};
  for (const [path, buf] of bytes) inline[path] = buf.toString('base64');
  return { discId: disc.id, name: disc.name, files: listed.map(({ path, size }) => ({ path, size })), inline };
}

/** The largest `.M2TS` in an ISO disc's BDMV/STREAM. */
export function largestIsoClip(tree: ReadonlyMap<string, UdfFile>): UdfFile | null {
  let best: UdfFile | null = null;
  for (const f of tree.values()) if (/^BDMV\/STREAM\/[^/]+\.M2TS$/.test(f.path) && (!best || f.size > best.size)) best = f;
  return best;
}

/** The largest `.M2TS` under the disc folder's BDMV/STREAM, with its size. */
export async function largestClip(dir: string): Promise<{ abs: string; size: number } | null> {
  const bdmv = await child(dir, 'BDMV', 'dir');
  const stream = bdmv && (await child(bdmv, 'STREAM', 'dir'));
  if (!stream) return null;
  let best: { abs: string; size: number } | null = null;
  for (const e of await entries(stream)) {
    if (!e.isFile() || !e.name.toUpperCase().endsWith('.M2TS')) continue;
    try {
      const abs = join(stream, e.name);
      const { size } = await stat(abs);
      if (!best || size > best.size) best = { abs, size };
    } catch {
      // Vanished meanwhile.
    }
  }
  return best;
}
