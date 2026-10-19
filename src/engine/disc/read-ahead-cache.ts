/*
 * Original code for bluray-web: the on-disk read-ahead cache of a NAS disc (buffer first), in the Origin Private File
 * System.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/** The cache's folder in the origin's private file system; one folder per disc below it. */
export const CACHE_DIR = 'read-ahead';
/** A disc's cache is cleared once it is this old (counted from its first byte). */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const META = 'meta.json';

export interface ReadAheadCacheDeps {
  /** The origin's private file system (navigator.storage.getDirectory()), or a stand-in. */
  readonly root: () => Promise<FileSystemDirectoryHandle>;
  /** Epoch ms. */
  readonly now: () => number;
}

/** The part of FileSystemSyncAccessHandle used here (dedicated workers only). */
interface SyncHandle {
  read(buffer: Uint8Array, opts: { at: number }): number;
  write(buffer: Uint8Array, opts: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileHandle {
  createSyncAccessHandle(): Promise<SyncHandle>;
}

interface DirHandle {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

/** One cached file: its bytes at their own offsets, and the ranges held, kept in a small JSON index beside it. */
interface CachedFile {
  readonly data: SyncHandle;
  readonly index: SyncHandle;
  /** Sorted, disjoint, non-touching [start, end) ranges. */
  ranges: Array<[number, number]>;
}

/**
 * Byte ranges of one disc's files, kept on disk so the bytes needed to play straight through can be fetched ahead of
 * time. Written through sync access handles, so it runs in a dedicated worker (the engine's).
 */
export class ReadAheadCache {
  /** Each file's state once opened (null: not cached), by disc path. */
  private readonly files = new Map<string, Promise<CachedFile | null>>();
  private closed = false;

  private constructor(
    private readonly top: DirHandle,
    private readonly name: string,
    private dir: DirHandle,
    private readonly deps: ReadAheadCacheDeps,
  ) {}

  static async open(discId: string, deps: ReadAheadCacheDeps): Promise<ReadAheadCache> {
    const root = (await deps.root()) as unknown as DirHandle;
    const top = await root.getDirectoryHandle(CACHE_DIR, { create: true });
    const name = safeName(discId);
    const dir = await top.getDirectoryHandle(name, { create: true });
    return new ReadAheadCache(top, name, dir, deps);
  }

  /** Removes every disc's cache (a disc not on the NAS opened). */
  static async clearAll(root: () => Promise<FileSystemDirectoryHandle>): Promise<void> {
    const dir = (await root()) as unknown as DirHandle;
    await dir.removeEntry(CACHE_DIR, { recursive: true }).catch(() => undefined); // none yet, or in use
  }

  /** Removes every other disc's cache, and this disc's once it is over 24 hours old. */
  async clearOthers(): Promise<void> {
    const others: string[] = [];
    for await (const entry of this.top.keys()) if (entry !== this.name) others.push(entry);
    for (const other of others) await this.top.removeEntry(other, { recursive: true }).catch(() => undefined);
    const created = await this.created();
    if (created !== null && this.deps.now() - created > CACHE_MAX_AGE_MS) {
      this.closeFiles();
      await this.top.removeEntry(this.name, { recursive: true });
      this.dir = await this.top.getDirectoryHandle(this.name, { create: true });
    }
  }

  /** Stores `bytes` at `offset` of `path`. */
  async write(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    if (this.closed) throw new DOMException('the read-ahead cache is closed', 'InvalidStateError');
    if ((await this.created()) === null) await this.writeJson(META, { created: this.deps.now() });
    const file = await this.file(path, true);
    if (!file) throw new Error(`cannot cache ${path}`);
    file.data.write(bytes, { at: offset });
    file.data.flush();
    file.ranges = addRange(file.ranges, offset, offset + bytes.length);
    const json = new TextEncoder().encode(JSON.stringify(file.ranges));
    file.index.truncate(0);
    file.index.write(json, { at: 0 });
    file.index.flush();
  }

  /** The bytes of `path` at `offset`, or null unless all `length` of them are held. */
  async read(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    const file = await this.file(path, false);
    if (!file || !covers(file.ranges, offset, offset + length)) return null;
    const out = new Uint8Array(length);
    const n = file.data.read(out, { at: offset });
    return n === length ? out : null;
  }

  /** Whether all of `offset`..`offset + length` of `path` is held. */
  async has(path: string, offset: number, length: number): Promise<boolean> {
    const file = await this.file(path, false);
    return file !== null && covers(file.ranges, offset, offset + length);
  }

  /** Lets go of the files (the disc closed); what is on disk stays for the next open of this disc. */
  close(): void {
    this.closed = true;
    this.closeFiles();
  }

  private closeFiles(): void {
    const open = [...this.files.values()];
    this.files.clear();
    for (const p of open) {
      void p.then((f) => {
        f?.data.close();
        f?.index.close();
      });
    }
  }

  /** The file's state, opened once; with `create`, made when it isn't cached yet. */
  private async file(path: string, create: boolean): Promise<CachedFile | null> {
    for (;;) {
      if (this.closed) return null;
      const pending = this.files.get(path);
      if (pending) {
        const file = await pending;
        if (file || !create) return file;
        if (this.files.get(path) !== pending) continue; // another call replaced it meanwhile
      }
      const opening = this.openFile(path, create);
      this.files.set(path, opening);
      return opening;
    }
  }

  private async openFile(path: string, create: boolean): Promise<CachedFile | null> {
    const base = safeName(path);
    let dataHandle: FileHandle;
    let indexHandle: FileHandle;
    try {
      dataHandle = await this.dir.getFileHandle(`${base}.bin`, { create });
      indexHandle = await this.dir.getFileHandle(`${base}.json`, { create });
    } catch (err) {
      if (!create && err instanceof DOMException && err.name === 'NotFoundError') return null;
      throw err;
    }
    const data = await dataHandle.createSyncAccessHandle();
    let index: SyncHandle;
    try {
      index = await indexHandle.createSyncAccessHandle();
    } catch (err) {
      data.close();
      throw err;
    }
    let ranges: Array<[number, number]> = [];
    try {
      const parsed: unknown = JSON.parse(readText(index) || '[]');
      if (Array.isArray(parsed)) ranges = parsed.filter(isRange).sort((a, b) => a[0] - b[0]).reduce<Array<[number, number]>>((acc, [s, e]) => addRange(acc, s, e), []);
    } catch {
      ranges = []; // a damaged index holds nothing
    }
    // Ranges past the data written (a write cut short) are not held.
    const size = data.getSize();
    ranges = ranges.flatMap(([s, e]): Array<[number, number]> => (s >= size ? [] : [[s, Math.min(e, size)]]));
    return { data, index, ranges };
  }

  /** When this disc's cache got its first byte, or null when it has none. */
  private async created(): Promise<number | null> {
    const meta = await this.readJson(META);
    return typeof meta === 'object' && meta !== null && typeof (meta as { created?: unknown }).created === 'number' ? (meta as { created: number }).created : null;
  }

  private async readJson(name: string): Promise<unknown> {
    let handle: SyncHandle;
    try {
      handle = await (await this.dir.getFileHandle(name)).createSyncAccessHandle();
    } catch {
      return null;
    }
    try {
      return JSON.parse(readText(handle));
    } catch {
      return null;
    } finally {
      handle.close();
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    const handle = await (await this.dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
    try {
      handle.truncate(0);
      handle.write(new TextEncoder().encode(JSON.stringify(value)), { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
  }
}

/** A file name for any id or path: letters, digits and '-' stay, every other UTF-8 byte becomes '_xx' (so '_' too). */
export function safeName(id: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(id)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9-]/.test(c) ? c : `_${byte.toString(16).padStart(2, '0')}`;
  }
  return out || '_';
}

function readText(handle: SyncHandle): string {
  const bytes = new Uint8Array(handle.getSize());
  handle.read(bytes, { at: 0 });
  return new TextDecoder().decode(bytes);
}

function isRange(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && Number.isSafeInteger(v[0]) && Number.isSafeInteger(v[1]) && v[0] >= 0 && v[1] > v[0];
}

/** `ranges` with [start, end) added, merged with any range it overlaps or touches. */
function addRange(ranges: ReadonlyArray<[number, number]>, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = start;
  let e = end;
  let placed = false;
  for (const [rs, re] of ranges) {
    if (re < s) out.push([rs, re]);
    else if (rs > e) {
      if (!placed) {
        out.push([s, e]);
        placed = true;
      }
      out.push([rs, re]);
    } else {
      s = Math.min(s, rs);
      e = Math.max(e, re);
    }
  }
  if (!placed) out.push([s, e]);
  return out;
}

function covers(ranges: ReadonlyArray<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([s, e]) => s <= start && end <= e);
}
