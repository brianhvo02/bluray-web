/**
 * Posters and banners, fetched from the sources' own image sizes (AniList medium/large, TMDB w185/w500; no resizing,
 * as the server has no native dependencies) and kept in `<dir>/<artId>-<size>`, within a byte budget that drops the
 * least recently used files. Original code.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCode, replaceAtomically } from '../atomic-json';

const DEFAULT_BUDGET = 500 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface Stored {
  type: string;
  bytes: number;
  usedAt: number;
}

export class ArtCache {
  private readonly index: string;
  private readonly files = new Map<string, Stored>();
  private readonly inFlight = new Map<string, Promise<{ path: string; type: string } | null>>();

  constructor(
    private readonly dir: string,
    private readonly fetch: typeof globalThis.fetch,
    private readonly budgetBytes = DEFAULT_BUDGET,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true });
    this.index = join(dir, 'index.json');
    try {
      const data = JSON.parse(readFileSync(this.index, 'utf8')) as Record<string, Stored>;
      for (const [name, s] of Object.entries(data)) {
        if (typeof s?.type === 'string' && typeof s.bytes === 'number' && typeof s.usedAt === 'number') this.files.set(name, s);
      }
    } catch (err) {
      if (!isCode(err, 'ENOENT')) console.error(`art index ${this.index} is unreadable; starting empty`, err);
    }
  }

  /** The cached image, fetched from `url` when it isn't cached; null when the fetch fails or isn't an image. */
  get(artId: string, size: 'small' | 'large', url: string): Promise<{ path: string; type: string } | null> {
    if (!SAFE_ID.test(artId)) return Promise.resolve(null);
    const name = `${artId}-${size}`;
    const running = this.inFlight.get(name);
    if (running) return running;
    const p = this.load(name, url).finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, p);
    return p;
  }

  private async load(name: string, url: string): Promise<{ path: string; type: string } | null> {
    const path = join(this.dir, name);
    const known = this.files.get(name);
    if (known) {
      try {
        await stat(path);
        known.usedAt = this.now();
        return { path, type: known.type };
      } catch (err) {
        if (!isCode(err, 'ENOENT')) throw err;
        this.files.delete(name);
      }
    }
    let bytes: Buffer;
    let type: string;
    try {
      const res = await this.fetch(url);
      type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!res.ok || !type.startsWith('image/')) return null;
      bytes = Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
    await writeFile(path, bytes, { mode: 0o600 });
    this.files.set(name, { type, bytes: bytes.length, usedAt: this.now() });
    await this.evict(name);
    this.save();
    return { path, type };
  }

  /** Deletes the least recently used files, never `keep`, until the cache fits its budget. */
  private async evict(keep: string): Promise<void> {
    let total = [...this.files.values()].reduce((sum, s) => sum + s.bytes, 0);
    const oldest = [...this.files.entries()].filter(([n]) => n !== keep).sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [name, s] of oldest) {
      if (total <= this.budgetBytes) break;
      await rm(join(this.dir, name), { force: true });
      this.files.delete(name);
      total -= s.bytes;
    }
  }

  private save(): void {
    replaceAtomically(this.index, JSON.stringify(Object.fromEntries(this.files)));
  }
}
