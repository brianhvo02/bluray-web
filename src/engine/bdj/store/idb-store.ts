/*
 * Original code for bluray-web: the browser's BD-J store, in IndexedDB. Discs from a picked folder keep their saved
 * data here; NAS discs too until the NAS store takes them over (Task 8 migrates per source, which each record names).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { SCOPE_QUOTA_BYTES, ScopeQuotaError, snapshotBytes, type BdjStore, type LoadedSnapshot, type SaveResult, type Snapshot, type SnapshotFile } from './bdj-store';

export const BDJ_STORE_DB = 'bdj-store';
export const BDJ_STORE_DB_VERSION = 1;
/** Object store of ScopeRecords, keyed `<source>|<scope>`, with an index on `source`. */
export const SCOPES_STORE = 'scopes';
export const SOURCE_INDEX = 'source';

/** One scope's snapshot as IndexedDB keeps it. */
export interface ScopeRecord {
  /** `nas:<nasDiscId>` or `local` (scopes.ts storeSource). */
  readonly source: string;
  /** `persistent/<orgId>` or `buda/<orgId>/<discId>`. */
  readonly scope: string;
  readonly etag: string;
  readonly files: readonly SnapshotFile[];
  /** The files' bytes together. */
  readonly bytes: number;
  /** Epoch ms of the save. */
  readonly savedAt: number;
}

export function recordKey(source: string, scope: string): string {
  return `${source}|${scope}`;
}

let etagCounter = 0;
function newEtag(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${(etagCounter++).toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** The scopes of one disc source in the database `bdj-store`. Each save is one readwrite transaction, committed when it resolves. */
export class IdbBdjStore implements BdjStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    readonly source: string,
    private readonly idb: IDBFactory = globalThis.indexedDB,
    private readonly quotaBytes = SCOPE_QUOTA_BYTES,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async load(scope: string): Promise<LoadedSnapshot> {
    const db = await this.open();
    const tx = db.transaction(SCOPES_STORE, 'readonly');
    const rec = (await request(tx.objectStore(SCOPES_STORE).get(recordKey(this.source, scope)))) as ScopeRecord | undefined;
    return rec ? { files: rec.files, etag: rec.etag } : { files: [], etag: null };
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    const bytes = snapshotBytes(snapshot);
    if (bytes > this.quotaBytes) throw new ScopeQuotaError(scope, bytes, this.quotaBytes);
    const db = await this.open();
    // strict: committed to disk when the transaction completes, so a page closed right after keeps the save (ruling R1)
    const tx = db.transaction(SCOPES_STORE, 'readwrite', { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
    done.catch(() => undefined); // awaited below
    const store = tx.objectStore(SCOPES_STORE);
    const key = recordKey(this.source, scope);
    const current = (await request(store.get(key))) as ScopeRecord | undefined;
    if ((current?.etag ?? null) !== etag) {
      await done;
      return { conflict: { files: current?.files ?? [], etag: current?.etag ?? '' } };
    }
    const record: ScopeRecord = {
      source: this.source,
      scope,
      etag: newEtag(),
      files: snapshot.files.map((f) => ({ path: f.path, mtime: f.mtime, bytes: f.bytes })),
      bytes,
      savedAt: this.nowMs(),
    };
    store.put(record, key);
    await done;
    return { etag: record.etag };
  }

  /** The scopes this source keeps (Task 8's migration). */
  async scopes(): Promise<string[]> {
    const db = await this.open();
    const tx = db.transaction(SCOPES_STORE, 'readonly');
    const recs = (await request(tx.objectStore(SCOPES_STORE).index(SOURCE_INDEX).getAll(this.source))) as ScopeRecord[];
    return recs.map((r) => r.scope).sort();
  }

  /** Closes the connection (another may open later). */
  close(): void {
    const db = this.db;
    this.db = null;
    void db?.then((d) => d.close(), () => undefined);
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const r = this.idb.open(BDJ_STORE_DB, BDJ_STORE_DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(SCOPES_STORE)) db.createObjectStore(SCOPES_STORE).createIndex(SOURCE_INDEX, 'source');
      };
      r.onsuccess = () => {
        const db = r.result;
        // a later version opened elsewhere (another tab's newer build) asks this connection to go
        db.onversionchange = () => {
          db.close();
          if (this.db === opening) this.db = null;
        };
        resolve(db);
      };
      // (blocked: an upgrade waits for older connections, which close on versionchange; the loads' timeout bounds it)
      r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
    });
    this.db = opening;
    opening.catch(() => {
      if (this.db === opening) this.db = null;
    });
    return opening;
  }
}
