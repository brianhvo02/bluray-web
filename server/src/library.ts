import { readFileSync } from 'node:fs';
import { opendir, rename, stat, writeFile } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { join } from 'node:path';
import type { DiscEntry, FolderEntry } from '../../src/engine/disc/nas-api';
import { discId } from './disc-id';
import { isoIsDisc } from './iso';

const MAX_DEPTH = 6;
const SKIPPED = new Set(['bk', 'lost+found']);

export interface LibraryOptions {
  /** Injected for tests. */
  opendir?: (path: string) => Promise<Dir>;
  /** Pause between directory reads, which keeps a scan gentle on disks that ignore ionice. Default 10. */
  scanPauseMs?: number;
}

interface Node {
  folders: Map<string, FolderEntry>;
  discs: DiscEntry[];
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'ja');

/** The next `at` (default 04:00) strictly after `now`, in server local time. */
export function nextNightly(now: Date, at: { hour: number; minute: number } = { hour: 4, minute: 0 }): Date {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), at.hour, at.minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export class Library {
  private tree = buildTree([]);
  private byId = new Map<string, DiscEntry>();
  private running: Promise<void> | null = null;
  private readonly open: (path: string) => Promise<Dir>;
  private readonly pauseMs: number;
  private reads = 0;
  /** Ids of `.iso` files whose UDF tree has no BDMV/INDEX.BDMV (or that aren't UDF), so a rescan doesn't read them again. */
  private readonly notDiscs = new Set<string>();

  constructor(
    private readonly roots: readonly { name: string; dir: string }[],
    private readonly cacheFile: string,
    options: LibraryOptions = {},
  ) {
    this.open = options.opendir ?? opendir;
    this.pauseMs = options.scanPauseMs ?? 10;
    try {
      const cached: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached)) this.install(cached.filter((e) => this.valid(e)));
    } catch {
      // No usable cache: the first scan fills it.
    }
  }

  get scanning(): boolean {
    return this.running !== null;
  }

  list(path: string): { folders: FolderEntry[]; discs: DiscEntry[] } | null {
    const key = path.replace(/\/+$/, '');
    // The top level shows the children of every root, merged.
    const nodes = key === '' ? this.roots.map((r) => this.tree.get(r.name)) : [this.tree.get(key)];
    if (key !== '' && !nodes[0]) return null;
    const present = nodes.filter((n): n is Node => n !== undefined);
    return {
      folders: present.flatMap((n) => [...n.folders.values()]).sort(byName),
      discs: present.flatMap((n) => n.discs).sort(byName),
    };
  }

  disc(id: string): DiscEntry | null {
    return this.byId.get(id) ?? null;
  }

  /** Where a disc's folder (or ISO file) is on this machine, or null if its root is no longer configured. */
  locate(disc: DiscEntry): string | null {
    const root = this.roots.find((r) => disc.path.startsWith(`${r.name}/`));
    return root ? join(root.dir, disc.path.slice(root.name.length + 1)) : null;
  }

  /** Rescans every root; list() keeps answering from the previous tree meanwhile. A scan already running is joined. */
  scan(): Promise<void> {
    this.running ??= this.doScan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private valid(e: unknown): e is DiscEntry {
    if (typeof e !== 'object' || e === null) return false;
    const d = e as Record<string, unknown>;
    return (
      typeof d.id === 'string' &&
      typeof d.name === 'string' &&
      typeof d.path === 'string' &&
      (d.kind === 'folder' || d.kind === 'iso') &&
      typeof d.sizeBytes === 'number' &&
      this.roots.some((r) => d.path === r.name || (d.path as string).startsWith(`${r.name}/`))
    );
  }

  private install(discs: DiscEntry[]): void {
    this.tree = buildTree(discs);
    this.byId = new Map(discs.map((d) => [d.id, d]));
  }

  private async doScan(): Promise<void> {
    const found: DiscEntry[] = [];
    const previous = this.byId;
    const progressive = previous.size === 0;
    this.reads = 0;
    for (const root of this.roots) {
      await this.scanRoot(root, found, previous);
      if (progressive) this.install([...found]);
    }
    this.install(found);
    try {
      const tmp = `${this.cacheFile}.tmp`;
      await writeFile(tmp, JSON.stringify(found));
      await rename(tmp, this.cacheFile);
    } catch (err) {
      console.error('could not write the library cache', err);
    }
  }

  private async scanRoot(root: { name: string; dir: string }, out: DiscEntry[], previous: Map<string, DiscEntry>): Promise<void> {
    let queue: { rel: string; abs: string; depth: number }[] = [{ rel: root.name, abs: root.dir, depth: 0 }];
    while (queue.length > 0) {
      const next: typeof queue = [];
      for (const dir of queue) {
        const entries = await this.readDir(dir.abs);
        if (!entries || (dir.depth === 0 && entries.length === 0)) {
          // An unreadable or empty root (a drive that isn't mounted) keeps what it had rather than losing its discs.
          if (dir.depth === 0) for (const d of previous.values()) if (d.path === root.name || d.path.startsWith(`${root.name}/`)) out.push(d);
          continue;
        }
        const bdmv = entries.find((e) => e.isDir && e.name.toLowerCase() === 'bdmv');
        if (bdmv) {
          const disc = await this.folderDisc(dir.rel, join(dir.abs, bdmv.name), previous);
          if (disc) {
            out.push(disc);
            continue;
          }
        }
        for (const e of entries) {
          if (e.name.startsWith('.') || SKIPPED.has(e.name.toLowerCase()) || e === bdmv) continue;
          const rel = `${dir.rel}/${e.name}`;
          if (e.isDir) {
            if (dir.depth < MAX_DEPTH) next.push({ rel, abs: join(dir.abs, e.name), depth: dir.depth + 1 });
          } else if (e.isFile && e.name.toLowerCase().endsWith('.iso')) {
            const disc = await this.isoDisc(rel, join(dir.abs, e.name), e.name, previous);
            if (disc) out.push(disc);
          }
        }
      }
      queue = next;
    }
  }

  private async readDir(abs: string): Promise<{ name: string; isDir: boolean; isFile: boolean }[] | null> {
    if (this.reads++ > 0 && this.pauseMs > 0) await new Promise((r) => setTimeout(r, this.pauseMs));
    let dir: Dir;
    try {
      dir = await this.open(abs);
    } catch {
      return null;
    }
    const entries: { name: string; isDir: boolean; isFile: boolean }[] = [];
    try {
      for await (const e of dir) entries.push({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() });
    } catch {
      return null;
    }
    return entries;
  }

  /**
   * An ISO disc if the image's UDF tree has BDMV/INDEX.BDMV. Its id is made from the path, image size and mtime; an
   * image whose id is already known either way (a disc in `previous`, or not a disc) isn't read again.
   */
  private async isoDisc(rel: string, abs: string, name: string, previous: Map<string, DiscEntry>): Promise<DiscEntry | null> {
    let st;
    try {
      st = await stat(abs);
    } catch {
      return null; // Vanished mid-scan.
    }
    const id = discId(rel, st.size, st.mtimeMs);
    const disc: DiscEntry = { id, name, path: rel, kind: 'iso', sizeBytes: st.size };
    if (previous.get(id)?.kind === 'iso') return disc;
    if (this.notDiscs.has(id)) return null;
    try {
      if (await isoIsDisc(abs)) return disc;
      this.notDiscs.add(id);
    } catch (err) {
      // A read error: left out of this scan, and tried again on the next.
      console.error(`could not read ${abs}`, err);
    }
    return null;
  }

  /** A folder disc if `bdmvDir` holds index.bdmv; its size is that of the clips in STREAM, carried over from `previous` when the id is unchanged. */
  private async folderDisc(rel: string, bdmvDir: string, previous: Map<string, DiscEntry>): Promise<DiscEntry | null> {
    const entries = await this.readDir(bdmvDir);
    const index = entries?.find((e) => e.isFile && e.name.toLowerCase() === 'index.bdmv');
    if (!entries || !index) return null;
    let st;
    try {
      st = await stat(join(bdmvDir, index.name));
    } catch {
      return null;
    }
    const id = discId(rel, st.size, st.mtimeMs);
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const known = previous.get(id);
    // Same path, index size and mtime: the disc is unchanged, so skip reading STREAM again.
    if (known && known.kind === 'folder') return { id, name, path: rel, kind: 'folder', sizeBytes: known.sizeBytes };
    let sizeBytes = 0;
    const stream = entries.find((e) => e.isDir && e.name.toLowerCase() === 'stream');
    const streamDir = stream ? join(bdmvDir, stream.name) : null;
    for (const clip of streamDir ? ((await this.readDir(streamDir)) ?? []) : []) {
      if (!clip.isFile || !streamDir) continue;
      try {
        sizeBytes += (await stat(join(streamDir, clip.name))).size;
      } catch {
        // Vanished mid-scan.
      }
    }
    return { id, name, path: rel, kind: 'folder', sizeBytes };
  }
}

function buildTree(discs: readonly DiscEntry[]): Map<string, Node> {
  const tree = new Map<string, Node>([['', { folders: new Map(), discs: [] }]]);
  const node = (path: string): Node => {
    let n = tree.get(path);
    if (!n) tree.set(path, (n = { folders: new Map(), discs: [] }));
    return n;
  };
  for (const disc of discs) {
    const parts = disc.path.split('/');
    let parent = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parent === '' ? parts[i]! : `${parent}/${parts[i]}`;
      const holder = node(parent);
      const prev = holder.folders.get(path);
      holder.folders.set(path, { name: parts[i]!, path, discs: (prev?.discs ?? 0) + 1 });
      node(path);
      parent = path;
    }
    node(parent).discs.push(disc);
  }
  return tree;
}
