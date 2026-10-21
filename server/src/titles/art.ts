/**
 * Posters and banners, fetched from the sources' own image sizes (AniList large/extraLarge, 230 and 460 wide; TMDB w342/w780; no resizing,
 * as the server has no native dependencies) and kept in `<dir>/<artId>-<size>`, within a byte budget that drops the
 * least recently used files. Original code.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCode, replaceAtomically } from '../atomic-json';

const DEFAULT_BUDGET = 500 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SAVE_DELAY_MS = 5_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SIZES = new Set(['small', 'large']);
/** Raster types only: an SVG served from the API origin could run script (T8f). */
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const INDEX = 'index.json';
const STORED_NAME = /^[A-Za-z0-9_-]{1,64}-(?:small|large)$/;
/** Art comes from these hosts over https, never elsewhere (M4). */
const ART_HOSTS = new Set(['s4.anilist.co', 'image.tmdb.org']);

/** Whether `url` is an https URL on an allowed art host, with no credentials or port. */
function allowedArtUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  return u.protocol === 'https:' && ART_HOSTS.has(u.hostname) && u.port === '' && u.username === '' && u.password === '';
}

interface Stored {
  /** '' for a file found on disk but missing from the index: counted against the budget, fetched again on use. */
  type: string;
  bytes: number;
  usedAt: number;
}

export interface ArtCacheOptions {
  readonly now?: () => number;
  /** Larger bodies are abandoned. Default 5 MB. */
  readonly maxBytes?: number;
  /** A fetch, body included, is abandoned after this. Default 15 s. */
  readonly timeoutMs?: number;
  /** Hit times are saved this long after a hit. Default 5 s. */
  readonly saveDelayMs?: number;
}

export class ArtCache {
  private readonly index: string;
  private readonly files = new Map<string, Stored>();
  private readonly inFlight = new Map<string, Promise<{ path: string; type: string } | null>>();
  private readonly now: () => number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dir: string,
    private readonly fetch: typeof globalThis.fetch,
    private readonly budgetBytes = DEFAULT_BUDGET,
    private readonly opts: ArtCacheOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    mkdirSync(dir, { recursive: true });
    this.index = join(dir, INDEX);
    try {
      const data = JSON.parse(readFileSync(this.index, 'utf8')) as Record<string, Stored>;
      for (const [name, s] of Object.entries(data)) {
        if (STORED_NAME.test(name) && typeof s?.type === 'string' && typeof s.bytes === 'number' && typeof s.usedAt === 'number') this.files.set(name, s);
      }
    } catch (err) {
      if (!isCode(err, 'ENOENT')) console.error(`art index ${this.index} is unreadable; starting empty`, err);
    }
    // files written before a crash, but never indexed, still count against the budget
    for (const name of readdirSync(dir)) {
      if (name === INDEX || this.files.has(name)) continue;
      try {
        const st = statSync(join(dir, name));
        if (st.isFile()) this.files.set(name, { type: '', bytes: st.size, usedAt: 0 });
      } catch (err) {
        if (!isCode(err, 'ENOENT')) throw err;
      }
    }
    let total = this.total();
    for (const [name, s] of this.oldestFirst(null)) {
      if (total <= this.budgetBytes) break;
      rmSync(join(dir, name), { force: true });
      this.files.delete(name);
      total -= s.bytes;
    }
  }

  /** The cached image, fetched from `url` when it isn't cached; null when the fetch fails or isn't an allowed image. */
  get(artId: string, size: 'small' | 'large', url: string): Promise<{ path: string; type: string } | null> {
    if (!SAFE_ID.test(artId) || !SIZES.has(size)) return Promise.resolve(null);
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
    if (known && known.type !== '') {
      try {
        await stat(path);
        known.usedAt = this.now();
        this.saveSoon();
        return { path, type: known.type };
      } catch (err) {
        if (!isCode(err, 'ENOENT')) throw err;
        this.files.delete(name);
      }
    }
    const fetched = await this.download(url);
    if (!fetched) return null;
    await writeFile(path, fetched.bytes, { mode: 0o600 });
    this.files.set(name, { type: fetched.type, bytes: fetched.bytes.length, usedAt: this.now() });
    await this.evict(name);
    this.save();
    return { path, type: fetched.type };
  }

  /** The body of `url`, when it is an allowed image within the size cap and arrives within the timeout. */
  private async download(url: string): Promise<{ bytes: Buffer; type: string } | null> {
    if (!allowedArtUrl(url)) return null;
    const maxBytes = this.opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)]);
    try {
      const res = await this.fetch(url, { signal });
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const length = Number(res.headers.get('content-length') ?? '0');
      if (!res.ok || !TYPES.has(type) || length > maxBytes || !res.body) {
        abort.abort();
        return null;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          abort.abort();
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
      return { bytes: Buffer.concat(chunks), type };
    } catch {
      return null;
    }
  }

  /** Deletes the least recently used files, never `keep`, until the cache fits its budget. */
  private async evict(keep: string): Promise<void> {
    let total = this.total();
    for (const [name, s] of this.oldestFirst(keep)) {
      if (total <= this.budgetBytes) break;
      await rm(join(this.dir, name), { force: true });
      this.files.delete(name);
      total -= s.bytes;
    }
  }

  private total(): number {
    return [...this.files.values()].reduce((sum, s) => sum + s.bytes, 0);
  }

  private oldestFirst(keep: string | null): [string, Stored][] {
    return [...this.files.entries()].filter(([n]) => n !== keep).sort((a, b) => a[1].usedAt - b[1].usedAt);
  }

  /** Saves hit times shortly after a hit, once for a burst of hits. */
  private saveSoon(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, this.opts.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  private save(): void {
    replaceAtomically(this.index, JSON.stringify(Object.fromEntries([...this.files].filter(([, s]) => s.type !== ''))));
  }
}
