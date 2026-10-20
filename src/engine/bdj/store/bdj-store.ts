/*
 * Original code for bluray-web: where BD-J's saved data lives between viewings (spec §4.4). A scope (scopes.ts) is
 * read and written whole, as a snapshot, through a BdjStore: the browser's (idb-store.ts) or, later, the NAS's.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/** One file of a scope: its path relative to the scope (no leading slash), mtime in ms and bytes. */
export interface SnapshotFile {
  readonly path: string;
  /** Epoch ms. The NAS keeps whole seconds (the tar entry's mtime): merges compare seconds (mergeSnapshots). */
  readonly mtime: number;
  readonly bytes: Uint8Array;
}

/** A scope's files at one moment: what a store keeps and replaces whole. */
export interface Snapshot {
  readonly files: ReadonlyArray<SnapshotFile>;
}

/** A loaded snapshot with the version a save must name: null when the store holds none for the scope. */
export interface LoadedSnapshot extends Snapshot {
  readonly etag: string | null;
}

export type SaveResult = { readonly etag: string } | { readonly conflict: Snapshot & { readonly etag: string } };

/**
 * Keeps BD-J scopes. load answers an empty snapshot (etag null) for a scope never saved, at once. save replaces the
 * scope atomically when `etag` is the version stored (null: none is stored), else answers the stored one as a conflict
 * (the caller merges and saves again). Over the quota it rejects with ScopeQuotaError and the stored snapshot stays.
 */
export interface BdjStore {
  load(scope: string): Promise<LoadedSnapshot>;
  save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult>;
}

/** Agreed with the NAS session: 16 MB per scope (the NAS also has 256 MB per person). */
export const SCOPE_QUOTA_BYTES = 16 * 1024 * 1024;

/** A save past a quota (the NAS's 507): Java sees a full disk, and the stored snapshot stays the last complete one. */
export class ScopeQuotaError extends Error {
  constructor(
    readonly scope: string,
    readonly bytes: number,
    readonly limitBytes: number,
  ) {
    super(`${scope}: ${bytes} bytes is over the quota of ${limitBytes} bytes (No space left on device)`);
    this.name = 'ScopeQuotaError';
  }
}

export const EMPTY_SNAPSHOT: LoadedSnapshot = { files: [], etag: null };

/** The bytes a snapshot's files hold together (what the quota counts). */
export function snapshotBytes(s: Snapshot): number {
  let n = 0;
  for (const f of s.files) n += f.bytes.length;
  return n;
}

/** Whole seconds, as a tar entry carries an mtime. */
const seconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * A 412's merge (the NAS contract): every file of either side, and for a path in both the newer by mtime in whole
 * seconds; a tie keeps `local`, the write being retried. `fromRemote`: the paths the merge took from `remote` that
 * `local` lacks or had older.
 */
export function mergeSnapshots(local: Snapshot, remote: Snapshot): { readonly merged: Snapshot; readonly fromRemote: readonly SnapshotFile[] } {
  const byPath = new Map<string, SnapshotFile>();
  for (const f of local.files) byPath.set(f.path, f);
  const fromRemote: SnapshotFile[] = [];
  for (const f of remote.files) {
    const mine = byPath.get(f.path);
    if (mine && seconds(f.mtime) <= seconds(mine.mtime)) continue;
    byPath.set(f.path, f);
    fromRemote.push(f);
  }
  return { merged: { files: sortFiles([...byPath.values()]) }, fromRemote };
}

export function sortFiles(files: SnapshotFile[]): SnapshotFile[] {
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A store in memory, empty at first: what a browser with no saved data has (the replay harness and the library check
 * use it, so golden runs go through the store's paths with nothing stored).
 */
export class MemoryBdjStore implements BdjStore {
  private readonly scopes = new Map<string, LoadedSnapshot & { readonly etag: string }>();
  private n = 0;

  constructor(private readonly quotaBytes = SCOPE_QUOTA_BYTES) {}

  async load(scope: string): Promise<LoadedSnapshot> {
    return this.scopes.get(scope) ?? EMPTY_SNAPSHOT;
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    const bytes = snapshotBytes(snapshot);
    if (bytes > this.quotaBytes) throw new ScopeQuotaError(scope, bytes, this.quotaBytes);
    const current = this.scopes.get(scope);
    if ((current?.etag ?? null) !== etag) return { conflict: { files: current?.files ?? [], etag: current?.etag ?? '' } };
    const next = { files: snapshot.files.map((f) => ({ path: f.path, mtime: f.mtime, bytes: f.bytes.slice() })), etag: `m${++this.n}` };
    this.scopes.set(scope, next);
    return { etag: next.etag };
  }
}

/** Same paths, mtimes and bytes, in order. */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i]!;
    const y = b.files[i]!;
    if (x.path !== y.path || x.mtime !== y.mtime || x.bytes.length !== y.bytes.length) return false;
    if (x.bytes === y.bytes) continue;
    for (let j = 0; j < x.bytes.length; j++) if (x.bytes[j] !== y.bytes[j]) return false;
  }
  return true;
}
