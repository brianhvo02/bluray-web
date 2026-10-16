/*
 * Original code for bluray-web: the virtual file system that java.io and libbluray's file natives see.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ByteSource } from '../../disc/byte-source';
import type { ZipArchive } from './zip';

export interface VfsStat {
  readonly kind: 'file' | 'dir';
  readonly size: number;
  readonly mtimeMs: number;
}

export interface VfsHandle {
  readonly path: string;
  position: number;
  readonly size: () => number;
  readonly writable: boolean;
}

export interface VfsOptions {
  readonly disc: ByteSource | null;
  /** rt-bdj.jar; its lib/ entries appear under /jdk/lib/. */
  readonly jdkLib: ZipArchive;
  /** The disc's normalised file paths (FileSource.paths()); required when `disc` is given. */
  readonly discPaths?: Iterable<string>;
  readonly nowMs: () => number;
  /** Normalised (upper-case) disc path to the disc's own spelling, used for listings. */
  readonly originalNames?: ReadonlyMap<string, string>;
  /** Read-only files served under /app/, keyed by path relative to /app/. */
  readonly app?: ReadonlyMap<string, Uint8Array>;
}

export type VfsMode = 'r' | 'w' | 'a' | 'rw';

interface MemDir {
  readonly kind: 'dir';
  readonly children: Map<string, MemNode>;
  mtimeMs: number;
}
interface MemFile {
  readonly kind: 'file';
  buf: Uint8Array;
  len: number;
  mtimeMs: number;
}
type MemNode = MemDir | MemFile;

type Backing = { readonly type: 'disc' } | { readonly type: 'mem'; readonly root: MemDir } | { readonly type: 'ro'; readonly tree: RoTree };

class RoTree {
  private readonly files = new Map<string, () => Uint8Array>();
  private readonly sizes = new Map<string, number>();
  private readonly dirs = new Map<string, Set<string>>([['', new Set()]]);

  add(path: string, size: number, get: () => Uint8Array): void {
    const parts = path.split('/').filter((s) => s !== '');
    if (parts.length === 0) return;
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      this.link(dir, parts[i]!);
      dir = dir === '' ? parts[i]! : `${dir}/${parts[i]}`;
    }
    this.link(dir, parts[parts.length - 1]!);
    const full = parts.join('/');
    this.files.set(full, get);
    this.sizes.set(full, size);
  }

  private link(dir: string, name: string): void {
    let set = this.dirs.get(dir);
    if (!set) this.dirs.set(dir, (set = new Set()));
    set.add(name);
    const child = dir === '' ? name : `${dir}/${name}`;
    if (!this.dirs.has(child)) this.dirs.set(child, new Set());
  }

  isDir(path: string): boolean {
    return this.dirs.has(path) && !this.files.has(path);
  }
  fileSize(path: string): number | undefined {
    return this.sizes.get(path);
  }
  bytes(path: string): Uint8Array | undefined {
    return this.files.get(path)?.();
  }
  list(path: string): string[] | null {
    const set = this.isDir(path) ? this.dirs.get(path) : undefined;
    return set ? [...set].sort() : null;
  }
}

class Handle implements VfsHandle {
  position = 0;
  constructor(
    readonly path: string,
    readonly size: () => number,
    readonly writable: boolean,
    readonly append: boolean,
    readonly node: MemFile | null,
    readonly discPath: string | null,
    readonly data: (() => Uint8Array) | null,
  ) {}
}

const MOUNTS = ['/disc/', '/tmp/', '/persistent/', '/buda/', '/jdk/', '/app/'] as const;

const SPECIAL_NAMES = new Map([
  ['INDEX.BDMV', 'index.bdmv'],
  ['MOVIEOBJECT.BDMV', 'MovieObject.bdmv'],
  ['ID.BDMV', 'id.bdmv'],
  ['SOUND.BDMV', 'sound.bdmv'],
]);

function newDir(now: number): MemDir {
  return { kind: 'dir', children: new Map(), mtimeMs: now };
}

export class Vfs {
  readonly mounts: readonly string[] = MOUNTS;
  private readonly disc: ByteSource | null;
  private readonly nowMs: () => number;
  private readonly backings = new Map<string, Backing>();
  private readonly discDirs = new Map<string, Set<string>>([['', new Set()]]);
  private readonly spelling = new Map<string, string>();
  private readonly jdkCache = new Map<string, Uint8Array>();

  constructor(opts: VfsOptions) {
    this.disc = opts.disc;
    this.nowMs = opts.nowMs;
    if (opts.disc) {
      if (!opts.discPaths) throw new Error('Vfs: discPaths is required when a disc is given');
      for (const path of opts.discPaths) {
        const parts = path.toUpperCase().split('/').filter(Boolean);
        let dir = '';
        for (let i = 0; i < parts.length - 1; i++) {
          let kids = this.discDirs.get(dir);
          if (!kids) this.discDirs.set(dir, (kids = new Set()));
          kids.add(parts[i]!);
          dir = dir === '' ? parts[i]! : `${dir}/${parts[i]}`;
          if (!this.discDirs.has(dir)) this.discDirs.set(dir, new Set());
        }
        if (parts.length > 0) this.discDirs.get(dir)!.add(parts[parts.length - 1]!);
      }
    }
    const now = opts.nowMs();
    this.backings.set('disc', { type: 'disc' });
    for (const m of ['tmp', 'persistent', 'buda']) this.backings.set(m, { type: 'mem', root: newDir(now) });

    const jdk = new RoTree();
    for (const name of opts.jdkLib.names) {
      const entry = opts.jdkLib.entries.get(name);
      if (!entry || !name.startsWith('lib/') || name.endsWith('/')) continue;
      jdk.add(name, entry.size, () => {
        let data = this.jdkCache.get(name);
        if (!data) {
          data = opts.jdkLib.read(name) ?? new Uint8Array(0);
          this.jdkCache.set(name, data);
        }
        return data;
      });
    }
    this.backings.set('jdk', { type: 'ro', tree: jdk });

    const app = new RoTree();
    for (const [path, bytes] of opts.app ?? []) app.add(path.replace(/^\/?(app\/)?/, ''), bytes.length, () => bytes);
    this.backings.set('app', { type: 'ro', tree: app });

    for (const [key, original] of opts.originalNames ?? []) {
      const keyParts = key.split('/').filter(Boolean);
      const origParts = original.split('/').filter(Boolean).slice(-keyParts.length);
      if (origParts.length !== keyParts.length) continue;
      for (let i = 0; i < keyParts.length; i++) this.spelling.set(keyParts.slice(0, i + 1).join('/'), origParts[i]!);
    }
  }

  canonicalize(path: string): string {
    const out: string[] = [];
    for (const seg of path.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return `/${out.join('/')}`;
  }

  stat(path: string): VfsStat | null {
    const r = this.resolve(path);
    if (!r) return null;
    if (r.mount === null) return { kind: 'dir', size: 0, mtimeMs: 0 };
    const b = this.backings.get(r.mount)!;
    if (b.type === 'mem') {
      const node = this.walk(b.root, r.rest);
      if (!node) return null;
      return { kind: node.kind, size: node.kind === 'file' ? node.len : 0, mtimeMs: node.mtimeMs };
    }
    if (b.type === 'ro') {
      const key = r.rest.join('/');
      const size = b.tree.fileSize(key);
      if (size !== undefined) return { kind: 'file', size, mtimeMs: 0 };
      return b.tree.isDir(key) ? { kind: 'dir', size: 0, mtimeMs: 0 } : null;
    }
    return this.discStat(r.rest);
  }

  list(dir: string): string[] | null {
    const r = this.resolve(dir);
    if (!r) return null;
    if (r.mount === null) return this.mounts.map((m) => m.slice(1, -1)).sort();
    const b = this.backings.get(r.mount)!;
    if (b.type === 'mem') {
      const node = this.walk(b.root, r.rest);
      return node?.kind === 'dir' ? [...node.children.keys()].sort() : null;
    }
    if (b.type === 'ro') return b.tree.list(r.rest.join('/'));
    return this.discList(r.rest);
  }

  mkdir(path: string): boolean {
    const t = this.memParent(path);
    if (!t || t.parent.children.has(t.name)) return false;
    const now = this.nowMs();
    t.parent.children.set(t.name, newDir(now));
    t.parent.mtimeMs = now;
    return true;
  }

  delete(path: string): boolean {
    const t = this.memParent(path);
    if (!t) return false;
    const node = t.parent.children.get(t.name);
    if (!node || (node.kind === 'dir' && node.children.size > 0)) return false;
    t.parent.children.delete(t.name);
    t.parent.mtimeMs = this.nowMs();
    return true;
  }

  rename(from: string, to: string): boolean {
    const src = this.memParent(from);
    const dst = this.memParent(to);
    if (!src || !dst) return false;
    const node = src.parent.children.get(src.name);
    if (!node) return false;
    const existing = dst.parent.children.get(dst.name);
    if (existing === node) return true;
    if (existing && (existing.kind === 'dir' || node.kind === 'dir')) return false;
    if (node.kind === 'dir' && this.isWithin(node, dst.parent)) return false;
    src.parent.children.delete(src.name);
    dst.parent.children.set(dst.name, node);
    const now = this.nowMs();
    src.parent.mtimeMs = dst.parent.mtimeMs = now;
    return true;
  }

  /** Returns null when the file is missing, is a directory, or the mode needs a read-only mount to be written. */
  open(path: string, mode: VfsMode): VfsHandle | null {
    const r = this.resolve(path);
    if (!r || r.mount === null || r.rest.length === 0) return null;
    const canon = this.canonicalize(path);
    const b = this.backings.get(r.mount)!;
    if (b.type === 'mem') {
      const t = this.memParent(path);
      if (!t) return null;
      let node = t.parent.children.get(t.name);
      if (node?.kind === 'dir') return null;
      if (!node) {
        if (mode === 'r') return null;
        const now = this.nowMs();
        node = { kind: 'file', buf: new Uint8Array(0), len: 0, mtimeMs: now };
        t.parent.children.set(t.name, node);
        t.parent.mtimeMs = now;
      } else if (mode === 'w') {
        node.len = 0;
        node.mtimeMs = this.nowMs();
      }
      const file = node;
      const h = new Handle(canon, () => file.len, mode !== 'r', mode === 'a', file, null, null);
      if (mode === 'a') h.position = file.len;
      return h;
    }
    if (mode !== 'r') return null;
    if (b.type === 'ro') {
      const key = r.rest.join('/');
      const size = b.tree.fileSize(key);
      if (size === undefined) return null;
      return new Handle(canon, () => size, false, false, null, null, () => b.tree.bytes(key)!);
    }
    const discPath = r.rest.join('/').toUpperCase();
    if (!this.disc?.exists(discPath)) return null;
    const disc = this.disc;
    return new Handle(canon, () => disc.size(discPath), false, false, null, discPath, null);
  }

  /** Memory and /jdk/ reads are synchronous; /disc/ reads return a promise. Returns -1 at end of file. */
  read(h: VfsHandle, out: Uint8Array, offset: number, length: number): number | Promise<number> {
    const handle = h as Handle;
    if (length === 0) return 0;
    const n = Math.min(length, handle.size() - handle.position);
    if (n <= 0) return -1;
    const pos = handle.position;
    handle.position += n;
    if (handle.node) {
      out.set(handle.node.buf.subarray(pos, pos + n), offset);
      return n;
    }
    if (handle.data) {
      out.set(handle.data().subarray(pos, pos + n), offset);
      return n;
    }
    return this.disc!.read(handle.discPath!, pos, n).then((bytes) => {
      out.set(bytes.subarray(0, n), offset);
      handle.position -= n - bytes.length;
      return bytes.length;
    });
  }

  /** Returns false when the handle was not opened for writing (read-only mounts and 'r' handles). */
  write(h: VfsHandle, data: Uint8Array, offset: number, length: number): boolean {
    const handle = h as Handle;
    const file = handle.node;
    if (!file || !handle.writable) return false;
    if (handle.append) handle.position = file.len;
    const end = handle.position + length;
    if (end > file.buf.length) {
      const grown = new Uint8Array(Math.max(end, file.buf.length * 2, 64));
      grown.set(file.buf.subarray(0, file.len));
      file.buf = grown;
    }
    if (handle.position > file.len) file.buf.fill(0, file.len, handle.position);
    file.buf.set(data.subarray(offset, offset + length), handle.position);
    handle.position = end;
    if (end > file.len) file.len = end;
    file.mtimeMs = this.nowMs();
    return true;
  }

  close(_h: VfsHandle): void {}

  /** The path is on a writable (memory) mount, below its root. */
  writable(path: string): boolean {
    const r = this.resolve(path);
    return r !== null && r.mount !== null && r.rest.length > 0 && this.backings.get(r.mount)!.type === 'mem';
  }

  /** Sets a memory file's or directory's modification time; false elsewhere or when it is missing. */
  setMtime(path: string, ms: number): boolean {
    const r = this.resolve(path);
    if (!r || r.mount === null) return false;
    const b = this.backings.get(r.mount)!;
    if (b.type !== 'mem') return false;
    const node = this.walk(b.root, r.rest);
    if (!node) return false;
    node.mtimeMs = ms;
    return true;
  }

  /** Cuts or zero-extends a writable handle's file to `length` bytes; the position moves back to the end if beyond it. */
  truncate(h: VfsHandle, length: number): boolean {
    const handle = h as Handle;
    const file = handle.node;
    if (!file || !handle.writable) return false;
    if (length > file.buf.length) {
      const grown = new Uint8Array(length);
      grown.set(file.buf.subarray(0, file.len));
      file.buf = grown;
    } else if (length > file.len) file.buf.fill(0, file.len, length);
    file.len = length;
    if (handle.position > length) handle.position = length;
    file.mtimeMs = this.nowMs();
    return true;
  }

  private resolve(path: string): { mount: string | null; rest: string[] } | null {
    if (!path.startsWith('/')) return null;
    const parts = this.canonicalize(path).split('/').filter(Boolean);
    if (parts.length === 0) return { mount: null, rest: [] };
    const mount = parts[0]!;
    if (!this.backings.has(mount)) return null;
    return { mount, rest: parts.slice(1) };
  }

  private walk(root: MemDir, rest: readonly string[]): MemNode | null {
    let node: MemNode = root;
    for (const seg of rest) {
      if (node.kind !== 'dir') return null;
      const next: MemNode | undefined = node.children.get(seg);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  /** The directory that holds `path` and the entry's name, for writable mounts only. */
  private memParent(path: string): { parent: MemDir; name: string } | null {
    const r = this.resolve(path);
    if (!r || r.mount === null || r.rest.length === 0) return null;
    const b = this.backings.get(r.mount)!;
    if (b.type !== 'mem') return null;
    const parent = this.walk(b.root, r.rest.slice(0, -1));
    return parent?.kind === 'dir' ? { parent, name: r.rest[r.rest.length - 1]! } : null;
  }

  private isWithin(dir: MemDir, target: MemDir): boolean {
    if (dir === target) return true;
    for (const child of dir.children.values()) if (child.kind === 'dir' && this.isWithin(child, target)) return true;
    return false;
  }

  private discStat(rest: readonly string[]): VfsStat | null {
    const key = rest.join('/').toUpperCase();
    if (this.discDirs.has(key)) return { kind: 'dir', size: 0, mtimeMs: 0 };
    if (this.disc?.exists(key)) return { kind: 'file', size: this.disc.size(key), mtimeMs: 0 };
    return null;
  }

  private discList(rest: readonly string[]): string[] | null {
    const key = rest.join('/').toUpperCase();
    const kids = this.discDirs.get(key);
    if (!kids) return null;
    const prefix = key === '' ? '' : `${key}/`;
    return [...kids].map((n) => this.spelling.get(prefix + n) ?? this.conventional(prefix + n, n)).sort();
  }

  private conventional(key: string, name: string): string {
    if (this.discDirs.has(key)) return name.toUpperCase();
    const upper = name.toUpperCase();
    const special = SPECIAL_NAMES.get(upper);
    if (special) return special;
    const dot = upper.lastIndexOf('.');
    return dot < 0 ? upper : upper.slice(0, dot) + upper.slice(dot).toLowerCase();
  }
}
