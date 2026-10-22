/**
 * The cover image of a music release folder: a file the owner already put there (`cover.jpg`, `Front.png`...).
 * Read-only: it lists and sizes, never writes. Original code.
 */
import { join } from 'node:path';
import type { ListDir } from '../manifest';

const MAX_BYTES = 5 * 1024 * 1024;
const PRIORITY = ['cover', 'front', 'folder', 'jacket', 'jk'];
const IMAGE = /^(.*)\.(?:jpe?g|png|webp)$/i;

/** The absolute path of the best image directly in `dir` (not in subfolders), or null. Files over 5 MB are skipped. */
export async function findFolderCover(dir: string, listDir: ListDir, statSize: (abs: string) => Promise<number | null>): Promise<string | null> {
  const entries = await listDir(dir);
  if (!entries) return null;
  const images = entries
    .filter((e) => e.isFile && IMAGE.test(e.name))
    .map((e) => ({ name: e.name, rank: PRIORITY.indexOf(IMAGE.exec(e.name)![1]!.toLowerCase()) }))
    .map((e) => ({ ...e, rank: e.rank < 0 ? PRIORITY.length : e.rank }))
    .sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const img of images) {
    const abs = join(dir, img.name);
    const size = await statSize(abs);
    if (size !== null && size <= MAX_BYTES) return abs;
  }
  return null;
}
