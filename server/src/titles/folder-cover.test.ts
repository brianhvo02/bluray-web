import { describe, expect, it } from 'vitest';
import type { ListDir } from '../manifest';
import { findFolderCover } from './folder-cover';

const MB = 1024 * 1024;

/** A folder of files (name -> size) and subfolders. */
function folder(files: Record<string, number>, dirs: string[] = []) {
  const list: ListDir = async () => [
    ...Object.keys(files).map((name) => ({ name, isDir: false, isFile: true })),
    ...dirs.map((name) => ({ name, isDir: true, isFile: false })),
  ];
  const size = async (abs: string) => files[abs.slice('/m/'.length)] ?? null;
  return { list, size };
}

describe('findFolderCover', () => {
  it('prefers cover over front over other images', async () => {
    const f = folder({ 'zz.png': 10, 'Front.png': 10, 'cover.jpg': 10 });
    expect(await findFolderCover('/m', f.list, f.size)).toBe('/m/cover.jpg');
  });
  it('matches names case-insensitively', async () => {
    const f = folder({ 'zz.png': 10, 'Front.PNG': 10 });
    expect(await findFolderCover('/m', f.list, f.size)).toBe('/m/Front.PNG');
  });
  it('falls back to the first image by name', async () => {
    const f = folder({ 'b.webp': 10, 'a.jpeg': 10, 'notes.txt': 10 });
    expect(await findFolderCover('/m', f.list, f.size)).toBe('/m/a.jpeg');
  });
  it('skips dot files such as macOS resource forks', async () => {
    const f = folder({ '._a.jpg': 10, '.hidden.png': 10, 'b.png': 10 });
    expect(await findFolderCover('/m', f.list, f.size)).toBe('/m/b.png');
    expect(await findFolderCover('/m', folder({ '._a.jpg': 10 }).list, f.size)).toBeNull();
  });
  it('ignores subfolders and non-images', async () => {
    const f = folder({ 'notes.txt': 10, 'cover.svg': 10 }, ['cover.jpg']);
    expect(await findFolderCover('/m', f.list, f.size)).toBeNull();
  });
  it('skips a file over 5 MB and goes on', async () => {
    const f = folder({ 'Front.png': 30 * MB, 'zz.jpg': 200 * 1024 });
    expect(await findFolderCover('/m', f.list, f.size)).toBe('/m/zz.jpg');
  });
  it('is null with only an oversized file or an unreadable folder', async () => {
    const f = folder({ 'Front.png': 30 * MB });
    expect(await findFolderCover('/m', f.list, f.size)).toBeNull();
    expect(await findFolderCover('/m', async () => null, f.size)).toBeNull();
  });
});
