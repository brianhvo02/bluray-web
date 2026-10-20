/*
 * Original code for bluray-web: keeps a BD-J session's storage scopes (scopes.ts) in step with a BdjStore. The scopes
 * load before Libbluray.init, into the VFS's /persistent/ and /buda/; Java's writes mark a scope dirty, and it is saved
 * whole 2 s after the last one (spec §4.4), on the engine's flush (pagehide) and when BD-J stops.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Vfs, VfsChange } from '../jvm/vfs';
import { EMPTY_SNAPSHOT, SCOPE_QUOTA_BYTES, ScopeQuotaError, mergeSnapshots, sameSnapshot, snapshotBytes, sortFiles, type BdjStore, type Snapshot, type SnapshotFile } from './bdj-store';
import type { StoreScope } from './scopes';

/** The save follows the last write by this much (the plan's Global Constraints). */
export const SAVE_DEBOUNCE_MS = 2000;
/** A scope whose load has not answered by then stays in memory only for the session (a hung IndexedDB). */
export const LOAD_TIMEOUT_MS = 3000;
/** A save that keeps meeting newer snapshots gives up after this many tries (until the next write). */
const SAVE_ATTEMPTS = 3;

export type ScopeVfs = Pick<Vfs, 'importFiles' | 'exportFiles' | 'setQuota' | 'stat'>;

export interface ScopeSyncDeps {
  readonly store: BdjStore;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  readonly log: (line: string) => void;
  /** Whether a scope has changes not yet stored, on each change of it (the engine waits for the stop flush only then). */
  readonly onUnsaved?: (unsaved: boolean) => void;
  readonly quotaBytes?: number;
  readonly debounceMs?: number;
  readonly loadTimeoutMs?: number;
}

interface ScopeState {
  readonly scope: StoreScope;
  /** The scope did not load: it is never saved, so what the store holds is not replaced by less. */
  readonly memoryOnly: boolean;
  etag: string | null;
  /** The snapshot the store holds, as far as this session knows. */
  stored: Snapshot;
  dirty: boolean;
  /**
   * Files a write to was refused for room (quota or memory budget) since they were last emptied: saves keep their
   * stored version (or leave them out), so the store keeps the last complete snapshot (Review Focus 2).
   */
  readonly refused: Set<string>;
}

export class ScopeSync {
  private readonly states: ScopeState[];
  private vfs: ScopeVfs | null = null;
  private cancelTimer: (() => void) | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private saving = 0;
  private unsaved = false;
  private outsideLogged = false;

  private constructor(
    private readonly deps: ScopeSyncDeps,
    states: ScopeState[],
  ) {
    this.states = states;
  }

  /** Loads every scope at once; one that fails or times out stays in memory only (logged), the others carry on. */
  static async load(scopes: readonly StoreScope[], deps: ScopeSyncDeps): Promise<ScopeSync> {
    const timeout = deps.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    const states = await Promise.all(
      scopes.map(async (scope): Promise<ScopeState> => {
        let cancel: () => void = () => undefined;
        try {
          const loaded = await Promise.race([
            deps.store.load(scope.key),
            new Promise<never>((_, reject) => {
              cancel = deps.setTimer(timeout, () => reject(new Error(`no answer within ${timeout} ms`)));
            }),
          ]);
          return { scope, memoryOnly: false, etag: loaded.etag, stored: { files: sortFiles([...loaded.files]) }, dirty: false, refused: new Set() };
        } catch (e) {
          deps.log(`BD-J storage: ${scope.key} could not be loaded (${e instanceof Error ? e.message : String(e)}); what is written there lasts until BD-J stops`);
          return { scope, memoryOnly: true, etag: null, stored: EMPTY_SNAPSHOT, dirty: false, refused: new Set() };
        } finally {
          cancel();
        }
      }),
    );
    return new ScopeSync(deps, states);
  }

  get scopes(): readonly StoreScope[] {
    return this.states.map((s) => s.scope);
  }

  /** Puts the loaded snapshots into the VFS and sets each scope's quota; Java's changes count from now on. */
  attach(vfs: ScopeVfs): void {
    this.vfs = vfs;
    const quota = this.deps.quotaBytes ?? SCOPE_QUOTA_BYTES;
    for (const s of this.states) {
      // a loose-only scope's snapshot has no subfolders (they belong to the disc scopes)
      if (s.scope.looseOnly) s.stored = { files: s.stored.files.filter((f) => !f.path.includes('/')) };
      vfs.importFiles(s.scope.dir, s.stored.files);
      vfs.setQuota(s.scope.dir, quota, s.scope.looseOnly === true);
    }
  }

  /** The VFS's onChange. */
  changed(path: string, change: VfsChange, to?: string): void {
    if (!this.vfs) return;
    const from = this.locate(path);
    if (from) {
      if (change === 'delete' || (change === 'truncate' && this.vfs.stat(path)?.size === 0)) from.state.refused.delete(from.rel);
      if (change === 'rename' && to !== undefined) {
        const dest = this.locate(to);
        const wasRefused = from.state.refused.delete(from.rel);
        if (dest) {
          dest.state.refused.delete(dest.rel);
          if (wasRefused) dest.state.refused.add(dest.rel);
          this.markDirty(dest.state);
        }
      }
      this.markDirty(from.state);
    } else if (change === 'rename' && to !== undefined) {
      const dest = this.locate(to);
      if (dest) {
        dest.state.refused.delete(dest.rel);
        this.markDirty(dest.state);
      } else this.outside(to);
    } else if (change !== 'mkdir') this.outside(path);
  }

  /** The VFS's onFull: a write to `path` was refused for room. */
  refused(path: string): void {
    const at = this.locate(path);
    if (!at) return;
    at.state.refused.add(at.rel);
    this.markDirty(at.state);
  }

  /** Saves every dirty scope now (after any save under way); resolves once they are stored or have failed. */
  flush(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.flushing = this.flushing.then(() => this.saveDirty());
    return this.flushing;
  }

  private markDirty(state: ScopeState): void {
    if (state.memoryOnly) return;
    state.dirty = true;
    this.report();
    this.cancelTimer?.();
    this.cancelTimer = this.deps.setTimer(this.deps.debounceMs ?? SAVE_DEBOUNCE_MS, () => {
      this.cancelTimer = null;
      void this.flush();
    });
  }

  private report(): void {
    const unsaved = this.saving > 0 || this.states.some((s) => s.dirty);
    if (unsaved === this.unsaved) return;
    this.unsaved = unsaved;
    this.deps.onUnsaved?.(unsaved);
  }

  private async saveDirty(): Promise<void> {
    const dirty = this.states.filter((s) => s.dirty);
    if (dirty.length === 0) return;
    this.saving++;
    try {
      await Promise.all(dirty.map((s) => this.save(s)));
    } finally {
      this.saving--;
      this.report();
    }
  }

  private async save(state: ScopeState): Promise<void> {
    if (!this.vfs) return;
    state.dirty = false;
    let snapshot = this.snapshot(state);
    if (sameSnapshot(snapshot, state.stored)) return; // a directory made, a file rewritten as it was
    try {
      for (let attempt = 1; ; attempt++) {
        const result = await this.deps.store.save(state.scope.key, snapshot, state.etag);
        if ('etag' in result) {
          state.etag = result.etag;
          state.stored = snapshot;
          this.deps.log(`BD-J storage: saved ${state.scope.key} (${snapshot.files.length} files, ${snapshotBytes(snapshot)} bytes)`);
          return;
        }
        // stored meanwhile elsewhere (another tab, another device): merged per file, newer mtime wins, ties ours
        const { merged, fromRemote } = mergeSnapshots(snapshot, result.conflict);
        this.vfs.importFiles(state.scope.dir, fromRemote);
        state.etag = result.conflict.etag;
        state.stored = result.conflict;
        snapshot = merged;
        if (attempt >= SAVE_ATTEMPTS) throw new Error(`still stored elsewhere after ${attempt} tries`);
      }
    } catch (e) {
      if (e instanceof ScopeQuotaError) {
        this.deps.log(`BD-J storage: ${state.scope.key} was not saved: ${e.message}; the saved copy stays as it was`);
        return;
      }
      // tried again after the next write (or the stop flush)
      state.dirty = true;
      this.deps.log(`BD-J storage: ${state.scope.key} could not be saved (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /** The scope's files now, a refused file as stored (or left out). */
  private snapshot(state: ScopeState): Snapshot {
    const files: SnapshotFile[] = this.vfs!.exportFiles(state.scope.dir, state.scope.looseOnly === true);
    if (state.refused.size === 0) return { files };
    const stored = new Map(state.stored.files.map((f) => [f.path, f]));
    const out = files.filter((f) => !state.refused.has(f.path));
    for (const path of state.refused) {
      const f = stored.get(path);
      if (f) out.push(f);
    }
    return { files: sortFiles(out) };
  }

  /**
   * The scope holding a canonical VFS path, and the path relative to it; null outside every scope. A path is in one
   * scope at most: the innermost (a disc folder's scope before its organisation's loose files).
   */
  private locate(path: string): { readonly state: ScopeState; readonly rel: string } | null {
    let best: { readonly state: ScopeState; readonly rel: string } | null = null;
    for (const state of this.states) {
      const dir = state.scope.dir;
      if (!path.startsWith(`${dir}/`) && path !== dir) continue;
      const rel = path === dir ? '' : path.slice(dir.length + 1);
      if (state.scope.looseOnly && rel.includes('/')) continue;
      if (!best || dir.length > best.state.scope.dir.length) best = { state, rel };
    }
    return best;
  }

  /** A file changed on /persistent/ or /buda/ outside the loaded scopes is not kept past the session: logged once. */
  private outside(path: string): void {
    if (this.outsideLogged || !(path.startsWith('/persistent/') || path.startsWith('/buda/'))) return;
    this.outsideLogged = true;
    this.deps.log(`BD-J storage: ${path} is outside the disc's storage scopes; it lasts until BD-J stops`);
  }
}
