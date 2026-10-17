import { readFileSync } from 'node:fs';
import { opendir, rename, stat, writeFile } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { join } from 'node:path';
import type { DiscEntry, FolderEntry } from '../../src/engine/disc/nas-api';
import { discId } from './disc-id';

const MAX_DEPTH = 6;
const SKIPPED = new Set(['bk', 'lost+found']);

export interface LibraryOptions {
  /** Injected for tests. */
  opendir?: (path: string) => Promise<Dir>;
}

interface Node {
  folders: Map<string, FolderEntry>;
  discs: DiscEntry[];
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'ja');

/** The next 04:00 strictly after `now`, in server local time. */
export function nextNightly(now: Date): Date {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export class Library {
  private tree = buildTree([]);
  private byId = new Map<string, DiscEntry>();
  private running: Promise<void> | null = null;
  private readonly open: (path: string) => Promise<Dir>;

  constructor(
    private readonly roots: readonly { name: string; dir: string }[],
    private readonly cacheFile: string,
    options: LibraryOptions = {},
  ) {
    this.open = options.opendir ?? opendir;
    try {
      const cached: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached)) this.install(cached as DiscEntry[]);
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

  /** Rescans every root; list() keeps answering from the previous tree meanwhile. A scan already running is joined. */
  scan(): Promise<void> {
    this.running ??= this.doScan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private install(discs: DiscEntry[]): void {
    this.tree = buildTree(discs);
    this.byId = new Map(discs.map((d) => [d.id, d]));
  }

  private async doScan(): Promise<void> {
    const found: DiscEntry[] = [];
    for (const root of this.roots) await this.scanRoot(root, found);
    this.install(found);
    try {
      const tmp = `${this.cacheFile}.tmp`;
      await writeFile(tmp, JSON.stringify(found));
      await rename(tmp, this.cacheFile);
    } catch (err) {
      console.error('could not write the library cache', err);
    }
  }

  private async scanRoot(root: { name: string; dir: string }, out: DiscEntry[]): Promise<void> {
    let queue: { rel: string; abs: string; depth: number }[] = [{ rel: root.name, abs: root.dir, depth: 0 }];
    while (queue.length > 0) {
      const next: typeof queue = [];
      for (const dir of queue) {
        const entries = await this.readDir(dir.abs);
        if (!entries) continue;
        const bdmv = entries.find((e) => e.isDir && e.name.toLowerCase() === 'bdmv');
        if (bdmv) {
          const disc = await this.folderDisc(dir.rel, join(dir.abs, bdmv.name));
          if (disc) {
            out.push(disc);
            continue;
          }
        }
        for (const e of entries) {
          if (e.name.startsWith('.') || SKIPPED.has(e.name.toLowerCase())) continue;
          const rel = `${dir.rel}/${e.name}`;
          if (e.isDir) {
            if (dir.depth < MAX_DEPTH) next.push({ rel, abs: join(dir.abs, e.name), depth: dir.depth + 1 });
          } else if (e.isFile && e.name.toLowerCase().endsWith('.iso')) {
            try {
              const st = await stat(join(dir.abs, e.name));
              out.push({ id: discId(rel, st.size, st.mtimeMs), name: e.name, path: rel, kind: 'iso', sizeBytes: st.size });
            } catch {
              // Vanished mid-scan.
            }
          }
        }
      }
      queue = next;
    }
  }

  private async readDir(abs: string): Promise<{ name: string; isDir: boolean; isFile: boolean }[] | null> {
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

  /** A folder disc if `bdmvDir` holds index.bdmv; its size is that of the clips in STREAM. */
  private async folderDisc(rel: string, bdmvDir: string): Promise<DiscEntry | null> {
    const entries = await this.readDir(bdmvDir);
    const index = entries?.find((e) => e.isFile && e.name.toLowerCase() === 'index.bdmv');
    if (!entries || !index) return null;
    let st;
    try {
      st = await stat(join(bdmvDir, index.name));
    } catch {
      return null;
    }
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
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    return { id: discId(rel, st.size, st.mtimeMs), name, path: rel, kind: 'folder', sizeBytes };
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
