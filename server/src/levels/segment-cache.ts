import { mkdir, open, readFile, readdir, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isCode } from '../atomic-json';

const PART_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const SEGMENT_SUFFIX = '.seg';

function part(value: string | number, what: string): string {
  const s = String(value);
  if (!PART_RE.test(s) || s === '.' || s === '..') throw new Error(`levels: bad ${what} for the segment cache: ${s}`);
  return s;
}

/**
 * Encoded, re-muxed EP intervals on disk (spec §6.3): `<dir>/<discId>/<level>/<audio>/<clip>/<size>-<mtimeMs>/<index>.seg`,
 * one file per interval. The clip's size and mtime are part of the key, so a replaced clip is a miss. Files are written
 * atomically (a synced temp file, then a rename and a directory sync). An LRU by total bytes: past `limitBytes`, the
 * least recently used whole files go (a read counts as a use, and is written to the file's mtime so the order outlives a
 * restart). A file's directories go with its last file.
 */
export class SegmentCache {
  /** Path → bytes, least recently used first. */
  private readonly files = new Map<string, number>();
  private total = 0;
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly limitBytes: number,
  ) {}

  get totalBytes(): number {
    return this.total;
  }

  key(discId: string, level: string, audio: string | number, clip: string, clipSize: number, clipMtimeMs: number): string {
    return [
      part(discId, 'disc id'),
      part(level, 'level'),
      part(audio, 'audio'),
      part(clip, 'clip'),
      part(`${clipSize}-${clipMtimeMs}`, 'clip stamp'),
    ].join('/');
  }

  async get(key: string, index: number): Promise<Buffer | null> {
    await this.load();
    const path = this.pathOf(key, index);
    if (!this.files.has(path)) return null;
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw err;
      this.forget(path);
      return null;
    }
    this.touch(path);
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return bytes;
  }

  async put(key: string, index: number, bytes: Uint8Array): Promise<void> {
    await this.load();
    const path = this.pathOf(key, index);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const handle = await open(temp, 'w', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, path);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    await syncDir(dirname(path));
    this.forget(path);
    this.files.set(path, bytes.length);
    this.total += bytes.length;
    await this.evict(path);
  }

  private pathOf(key: string, index: number): string {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error(`levels: bad interval index ${index}`);
    const parts = key.split('/');
    if (parts.length !== 5) throw new Error(`levels: bad segment cache key ${key}`);
    parts.forEach((p) => part(p, 'key part'));
    return join(this.dir, ...parts, `${index}${SEGMENT_SUFFIX}`);
  }

  private touch(path: string): void {
    const size = this.files.get(path);
    if (size === undefined) return;
    this.files.delete(path);
    this.files.set(path, size);
  }

  private forget(path: string): void {
    const size = this.files.get(path);
    if (size === undefined) return;
    this.files.delete(path);
    this.total -= size;
  }

  /** Drops the least recently used files until the total fits; `keep`, just written, goes last. */
  private async evict(keep: string): Promise<void> {
    for (const [path] of this.files) {
      if (this.total <= this.limitBytes) return;
      if (path === keep) continue;
      this.forget(path);
      await unlink(path).catch((err: unknown) => {
        if (!isCode(err, 'ENOENT')) throw err;
      });
      await this.pruneDirs(dirname(path));
    }
  }

  /** Removes `from` and its parents up to the cache's own directory while they are empty. */
  private async pruneDirs(from: string): Promise<void> {
    for (let d = from; relative(this.dir, d) !== '' && !relative(this.dir, d).startsWith('..'); d = dirname(d)) {
      try {
        await rmdir(d);
      } catch {
        return; // not empty, or gone
      }
    }
  }

  /** Learns what earlier runs left: every segment file, oldest mtime first; stray temp files are removed. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const found: Array<{ path: string; size: number; mtimeMs: number }> = [];
      let entries: string[];
      try {
        entries = await readdir(this.dir, { recursive: true });
      } catch (err) {
        if (isCode(err, 'ENOENT')) return;
        throw err;
      }
      for (const name of entries) {
        const path = join(this.dir, name);
        if (name.endsWith('.tmp')) {
          await unlink(path).catch(() => {});
          continue;
        }
        if (!name.endsWith(SEGMENT_SUFFIX) || name.split(sep).length !== 6) continue;
        const s = await stat(path).catch(() => null);
        if (s?.isFile()) found.push({ path, size: s.size, mtimeMs: s.mtimeMs });
      }
      found.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path, 'en', { numeric: true }));
      for (const f of found) {
        if (this.files.has(f.path)) continue;
        this.files.set(f.path, f.size);
        this.total += f.size;
      }
    })();
    return this.loaded;
  }
}

/** Flushes a directory entry change; not every platform allows it, hence best effort. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort.
  }
}
