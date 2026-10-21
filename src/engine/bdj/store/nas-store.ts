/*
 * Original code for bluray-web: BD-J saved data on the NAS, per person (the NAS store contract; spec §4.4, rulings
 * R15 and R17). NasBdjStore is the HTTP client of `bdj-store/<scope>`; WriteAheadNasStore keeps every change in this
 * browser's IndexedDB first (100 ms after a write, marked pending) and puts it on the NAS 2 s later, so a page closed
 * before the NAS has it loses nothing here and the NAS catches up at the next open; NasDiscStore picks between them
 * for a disc opened from a server, by whose device this is (`GET me`).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import {
  NasQuotaError, ScopeQuotaError, mergeSnapshots, sameSnapshot, snapshotBytes, sortFiles,
  type BdjStore, type LoadedSnapshot, type SaveResult, type Snapshot, type SnapshotFile,
} from './bdj-store';
import { IDB_SAVE_DEBOUNCE_MS, IdbBdjStore, type ScopeRecord } from './idb-store';
import { readTar, tarPathFits, writeTar } from './tar';

/** A store request that has not answered after this long has failed (the write-ahead copy keeps the data). */
export const NAS_STORE_REQUEST_TIMEOUT_MS = 15_000;
/** A 503 (the scope's lock is busy) is tried again this many times, after its Retry-After (1 s). */
export const NAS_STORE_BUSY_RETRIES = 5;
/** The NAS put follows the last write by this much (the plan's 2 s; the write-ahead copy is saved after 100 ms). */
export const NAS_PUSH_DEBOUNCE_MS = 2000;
/** A disc that keeps writing is still put on the NAS this often. */
export const NAS_PUSH_MAX_WAIT_MS = 10_000;
/** After a put that failed (the NAS unreachable), the next try, while BD-J runs. */
export const NAS_PUSH_RETRY_MS = 30_000;
/**
 * The NAS's part of the boot: whose device this is and each scope's snapshot, within this long from the store's
 * creation (inside ScopeSync's LOAD_TIMEOUT_MS of 3 s), or the scope loads from this browser's copy.
 */
export const NAS_LOAD_BUDGET_MS = 2500;
/** A save that keeps meeting newer snapshots on the NAS gives up after this many tries (until the next push). */
const PUSH_ATTEMPTS = 3;

type SetTimer = (ms: number, fn: () => void) => () => void;
type Log = (line: string, error?: boolean) => void;

/** A request to the NAS store that failed: its HTTP status, or null when the NAS did not answer. */
export class NasStoreError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'NasStoreError';
  }
}

/** The NAS API base (`…/api/`) of a disc's base (`…/api/discs/<id>/`, RemoteDiscSpec.base); null for another shape. */
export function storeApiBase(discBase: string): string | null {
  const m = /^(.*\/)discs\/[^/]+\/$/.exec(discBase);
  return m ? m[1]! : null;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface NasBdjStoreDeps {
  readonly fetch: typeof fetch;
  /** The device's session token (the disc's); a 401 asks `refreshToken` for a fresh one, once per request. */
  readonly token: string;
  readonly refreshToken?: () => Promise<string>;
  /** Waits out a 503's Retry-After; setTimeout by default. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
}

/**
 * The NAS store's HTTP API (`<api>bdj-store/<scope>`, `<api>me`), the token as `t=` as for the disc's reads. A scope
 * is a ustar snapshot under a quoted ETag, sent back exactly as received: PUT with `If-Match: "<etag>"`, or
 * `If-None-Match: *` when the NAS has none; a 412 answers what the NAS holds now, as a conflict; a 507 throws
 * NasQuotaError; a 503 is tried again after its Retry-After.
 */
export class NasBdjStore implements BdjStore {
  readonly saveDebounceMs = NAS_PUSH_DEBOUNCE_MS;
  private token: string;
  private refreshing: Promise<string> | null = null;

  constructor(
    readonly apiBase: string,
    private readonly deps: NasBdjStoreDeps,
  ) {
    this.token = deps.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  /** Whose device this is: null when the server keeps no people (the dev disc server, an older NAS). */
  async me(): Promise<{ readonly personId: string; readonly personName: string | null } | null> {
    const res = await this.send('GET', 'me');
    if (res.status === 404) return discard(res, null);
    if (res.status !== 200) throw await failure(res, 'me');
    const body = (await res.json()) as { personId?: unknown; personName?: unknown };
    if (typeof body.personId !== 'string' || body.personId === '') return null;
    return { personId: body.personId, personName: typeof body.personName === 'string' ? body.personName : null };
  }

  async load(scope: string): Promise<LoadedSnapshot> {
    const res = await this.send('GET', `bdj-store/${scope}`);
    if (res.status !== 200) throw await failure(res, scope);
    const etag = res.headers.get('ETag');
    const files = readTar(new Uint8Array(await res.arrayBuffer()));
    return { files: sortFiles(files), etag: etag ?? null };
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    const body = writeTar(snapshot.files);
    const res = await this.send('PUT', `bdj-store/${scope}`, {
      'Content-Type': 'application/x-tar',
      ...(etag !== null ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
    }, body);
    switch (res.status) {
      case 200: {
        const next = res.headers.get('ETag');
        await discard(res, null);
        if (next === null) throw new NasStoreError(200, `${scope}: the NAS answered no ETag`);
        return { etag: next };
      }
      case 412: {
        // stored meanwhile elsewhere (another device of this person): what is there now, to merge
        await discard(res, null);
        const now = await this.load(scope);
        return { conflict: now };
      }
      case 507: {
        let limit: 'scope' | 'person' = 'scope';
        try {
          if (((await res.json()) as { limit?: unknown }).limit === 'person') limit = 'person';
        } catch {
          // the scope's, when the body does not say
        }
        throw new NasQuotaError(scope, snapshotBytes(snapshot), limit);
      }
      default:
        throw await failure(res, scope);
    }
  }

  /** One request, with a fresh token after a 401 (once) and again after a 503's Retry-After. */
  private async send(method: 'GET' | 'PUT', path: string, headers: Record<string, string> = {}, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
    let refreshed = false;
    for (let busy = 0; ; ) {
      const token = this.token;
      const res = await this.request(method, path, token, headers, body);
      if (res.status === 401) {
        await discard(res, null);
        if (refreshed || !this.deps.refreshToken) throw new NasStoreError(401, 'this device is no longer paired with the NAS');
        refreshed = true;
        // a request that went out with an older token tries the current one first
        if (this.token === token) {
          this.refreshing ??= this.deps.refreshToken().finally(() => (this.refreshing = null));
          try {
            this.token = await this.refreshing;
          } catch (e) {
            throw new NasStoreError(401, `no fresh session token (${messageOf(e)})`);
          }
        }
        continue;
      }
      if (res.status === 503 && busy < NAS_STORE_BUSY_RETRIES) {
        busy++;
        const seconds = Number(res.headers.get('Retry-After'));
        await discard(res, null);
        await (this.deps.sleep ?? sleep)(Number.isFinite(seconds) && seconds >= 0 && res.headers.has('Retry-After') ? seconds * 1000 : 1000);
        continue;
      }
      return res;
    }
  }

  private async request(method: string, path: string, token: string, headers: Record<string, string>, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
    const url = `${this.apiBase}${path}?t=${encodeURIComponent(token)}`;
    const controller = new AbortController();
    const timeoutMs = this.deps.timeoutMs ?? NAS_STORE_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.deps.fetch(url, { method, headers, ...(body ? { body } : {}), signal: controller.signal, cache: 'no-store' });
      // the body too, within the time: a scope is at most 16 MB
      const bytes = res.status === 200 || res.status === 507 ? await res.arrayBuffer() : null;
      return bytes === null ? res : new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      if (controller.signal.aborted) throw new NasStoreError(null, `the NAS did not answer within ${timeoutMs / 1000} s`);
      throw new NasStoreError(null, `the NAS could not be reached (${messageOf(e)})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discard<T>(res: Response, value: T): Promise<T> {
  try {
    await res.body?.cancel();
  } catch {
    // already read
  }
  return value;
}

/** A NasStoreError naming the status and the body's `error`. */
async function failure(res: Response, what: string): Promise<NasStoreError> {
  let error = '';
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') error = `: ${body.error}`;
  } catch {
    // no JSON body
  }
  return new NasStoreError(res.status, `${what}: HTTP ${res.status}${error}`);
}

/** Rejects with `budget`'s reason if it settles first. */
function within<T>(p: Promise<T>, budget: Promise<never>): Promise<T> {
  return Promise.race([p, budget]);
}

/** The write-ahead copies of one person's scopes, in this browser: the IndexedDB source of a NAS person. */
export function personSource(personId: string): string {
  return `nas-person:${personId}`;
}

export interface WriteAheadDeps {
  readonly nas: Pick<NasBdjStore, 'load' | 'save'>;
  /** This person's write-ahead copies (personSource). */
  readonly local: IdbBdjStore;
  /** The disc's browser-only records from before (`nas:<discId>`, scopes.ts storeSource), moved to the NAS once. */
  readonly legacy?: IdbBdjStore | null;
  readonly personId: string;
  readonly setTimer: SetTimer;
  readonly log: Log;
  /**
   * The NAS refused a scope for room (507), or has taken it again: Java then sees a full disk (ScopeSync.full), as
   * libbluray's JVM does when its disk fills.
   */
  readonly onFull?: (scope: string, full: boolean) => void;
  /** Settles (rejects) when the NAS's part of the boot has run out of time: the loads then use this browser's copy. */
  readonly budget?: Promise<never>;
  readonly pushDebounceMs?: number;
  readonly pushMaxWaitMs?: number;
  readonly retryMs?: number;
}

interface WriteAheadScope {
  /** The NAS's version as last seen (null: it has none); undefined while unknown (the NAS did not answer). */
  nasEtag: string | null | undefined;
  /** The write-ahead record's version (null: none yet). */
  localEtag: string | null;
  /** What the NAS should hold: the last snapshot saved here, merged with what the NAS had. */
  local: Snapshot;
  /** The write-ahead copy is not on the NAS yet. */
  pending: boolean;
  /** Counts the saves, so a put knows whether a newer one came while it ran. */
  gen: number;
  /** A browser-only record merged into this one: its version, removed once the NAS has the merge. */
  legacyEtag: string | null;
  /** The NAS refused it for room (onFull). */
  full: boolean;
  /** Puts of this scope, one after another. */
  pushing: Promise<void>;
}

/**
 * Ruling R17. A NAS disc's saves go to this browser's IndexedDB first, within 100 ms (saveDebounceMs) and marked
 * pending, then to the NAS 2 s after the last one (at most 10 s after the first; at once on flush). A copy still
 * pending at the next load is merged per file by mtime with the NAS's, as on a 412, and put on the NAS straight away.
 * A load the NAS does not answer uses this browser's copy, when there is one; a failed put is tried again later and
 * at the next open. Nothing is lost on this device when the page goes before the NAS has it.
 */
export class WriteAheadNasStore implements BdjStore {
  readonly saveDebounceMs = IDB_SAVE_DEBOUNCE_MS;
  private readonly scopes = new Map<string, WriteAheadScope>();
  private cancelDebounce: (() => void) | null = null;
  private cancelMaxWait: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private readonly tooLongLogged = new Set<string>();

  constructor(private readonly deps: WriteAheadDeps) {}

  async load(scope: string): Promise<LoadedSnapshot> {
    const { local, legacy, personId, log } = this.deps;
    const fromNas = this.deps.budget ? within(this.deps.nas.load(scope), this.deps.budget) : this.deps.nas.load(scope);
    fromNas.catch(() => undefined); // awaited below
    const [rec, old] = await Promise.all([local.loadRecord(scope), legacy ? legacy.loadRecord(scope) : Promise.resolve(null)]);
    let files: readonly SnapshotFile[] = rec?.files ?? [];
    let etag = rec?.etag ?? null;
    let pending = rec?.pending === true;
    let legacyEtag: string | null = null;
    if (old && legacy) {
      if (old.migratedTo === undefined) {
        // the disc's saves from before the NAS kept them: into this person's copy, once (ruling R15's keys, unchanged)
        const moved = await this.migrate(scope, old, files, etag);
        files = moved.files;
        etag = moved.etag;
        pending = true;
        legacyEtag = old.etag;
      } else if (old.migratedTo === personId) {
        legacyEtag = old.etag; // merged before; removed once the NAS has it
      }
    }
    const state: WriteAheadScope = { nasEtag: undefined, localEtag: etag, local: { files: sortFiles([...files]) }, pending, gen: 0, legacyEtag, full: false, pushing: Promise.resolve() };
    this.scopes.set(scope, state);
    let remote: LoadedSnapshot;
    try {
      remote = await fromNas;
    } catch (e) {
      if (rec === null && legacyEtag === null) {
        log(`BD-J storage: ${scope} could not be loaded from the NAS (${messageOf(e)}), and this browser has no copy`, true);
        throw e;
      }
      log(`BD-J storage: ${scope} could not be loaded from the NAS (${messageOf(e)}); this browser's copy is used${pending ? ', and put on the NAS once it answers' : ''}`, true);
      if (pending) this.retryLater();
      return { files: state.local.files, etag };
    }
    state.nasEtag = remote.etag;
    if (pending) {
      // the last session's changes the NAS did not get: merged as on a 412 (newer mtime wins, ties ours) and put now
      state.local = mergeSnapshots(state.local, remote).merged;
      log(`BD-J storage: ${scope} has changes from this browser the NAS does not have yet: merged, and put on the NAS now`);
      this.soon();
      return { files: state.local.files, etag };
    }
    state.local = { files: remote.files };
    if (legacyEtag !== null) await this.dropLegacy(scope, state); // already on the NAS
    return { files: remote.files, etag };
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    const result = await this.deps.local.save(scope, snapshot, etag, { pending: true });
    if ('conflict' in result) return result;
    const state = this.state(scope);
    state.localEtag = result.etag;
    state.local = snapshot;
    state.pending = true;
    state.gen++;
    this.schedule();
    return result;
  }

  /** Puts every pending scope on the NAS now; settles once each is there or has failed (logged). */
  async flush(): Promise<void> {
    this.cancelDebounce?.();
    this.cancelDebounce = null;
    this.cancelMaxWait?.();
    this.cancelMaxWait = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    await Promise.all(
      [...this.scopes].map(([scope, state]) => {
        state.pushing = state.pushing.then(() => this.push(scope, state));
        return state.pushing;
      }),
    );
  }

  /** Whether a scope's write-ahead copy is still to go to the NAS (tests, diagnostics). */
  pendingScopes(): string[] {
    return [...this.scopes].filter(([, s]) => s.pending).map(([scope]) => scope).sort();
  }

  private state(scope: string): WriteAheadScope {
    let state = this.scopes.get(scope);
    if (!state) {
      state = { nasEtag: undefined, localEtag: null, local: { files: [] }, pending: false, gen: 0, legacyEtag: null, full: false, pushing: Promise.resolve() };
      this.scopes.set(scope, state);
    }
    return state;
  }

  private async migrate(scope: string, old: ScopeRecord, files: readonly SnapshotFile[], etag: string | null): Promise<{ files: readonly SnapshotFile[]; etag: string }> {
    const { local, legacy, personId, log } = this.deps;
    let mine: Snapshot = { files };
    let at = etag;
    for (let attempt = 1; ; attempt++) {
      const merged = mergeSnapshots(mine, { files: old.files }).merged;
      const result = await local.save(scope, merged, at, { pending: true });
      if ('etag' in result) {
        // marked, not removed: it goes only once the NAS has it
        await legacy!.mark(scope, old.etag, (r) => ({ ...r, migratedTo: personId }));
        log(`BD-J storage: ${scope}: this browser's saved data for the disc (${old.files.length} files) moves to the NAS`);
        return { files: merged.files, etag: result.etag };
      }
      if (attempt >= PUSH_ATTEMPTS) throw new Error(`${scope}: the copy in this browser kept changing while its old saves moved into it`);
      mine = result.conflict;
      at = result.conflict.etag;
    }
  }

  private async dropLegacy(scope: string, state: WriteAheadScope): Promise<void> {
    const etag = state.legacyEtag;
    if (etag === null || !this.deps.legacy) return;
    state.legacyEtag = null;
    try {
      if (await this.deps.legacy.remove(scope, etag)) this.deps.log(`BD-J storage: ${scope}: the NAS has this browser's old saved data; the old copy is removed`);
    } catch (e) {
      this.deps.log(`BD-J storage: ${scope}: the old copy in this browser could not be removed (${messageOf(e)})`, true);
    }
  }

  /** The snapshot as the NAS can hold it: a path too long for a ustar header stays in this browser only (logged once). */
  private forNas(scope: string, snapshot: Snapshot): Snapshot {
    if (snapshot.files.every((f) => tarPathFits(f.path))) return snapshot;
    const files = snapshot.files.filter((f) => {
      if (tarPathFits(f.path)) return true;
      const key = `${scope}/${f.path}`;
      if (!this.tooLongLogged.has(key)) {
        this.tooLongLogged.add(key);
        this.deps.log(`BD-J storage: ${scope}: ${f.path} has a path too long for the NAS (255 bytes); it stays in this browser only`, true);
      }
      return false;
    });
    return { files };
  }

  private async push(scope: string, state: WriteAheadScope): Promise<void> {
    if (!state.pending) return;
    const { nas, local, log } = this.deps;
    const gen = state.gen;
    let snapshot = this.forNas(scope, state.local);
    try {
      if (state.nasEtag === undefined) {
        const remote = await nas.load(scope);
        state.nasEtag = remote.etag;
        snapshot = mergeSnapshots(snapshot, remote).merged;
      }
      for (let attempt = 1; ; attempt++) {
        const result = await nas.save(scope, snapshot, state.nasEtag);
        if ('etag' in result) {
          state.nasEtag = result.etag;
          break;
        }
        // another device of this person put it meanwhile: merged per file, newer mtime wins (whole seconds), ties ours
        snapshot = mergeSnapshots(snapshot, result.conflict).merged;
        state.nasEtag = result.conflict.etag;
        if (attempt >= PUSH_ATTEMPTS) throw new Error(`still changed elsewhere after ${attempt} tries`);
      }
    } catch (e) {
      if (e instanceof ScopeQuotaError) {
        log(`BD-J storage: ${scope} was not put on the NAS: ${e.message}; this browser keeps it`, true);
        if (!state.full) {
          state.full = true;
          this.deps.onFull?.(scope, true);
        }
        return;
      }
      log(`BD-J storage: ${scope} could not be put on the NAS (${messageOf(e)}); this browser keeps it and tries again`, true);
      this.retryLater();
      return;
    }
    if (state.full) {
      state.full = false;
      this.deps.onFull?.(scope, false);
    }
    log(`BD-J storage: ${scope} is on the NAS (${snapshot.files.length} files, ${snapshotBytes(snapshot)} bytes)`);
    try {
      if (state.gen === gen && state.localEtag !== null) {
        // the write-ahead copy as the NAS has it now: marked (no new version) when the merge added nothing to it
        const toLocal = mergeSnapshots(state.local, snapshot).merged;
        if (sameSnapshot(toLocal, state.local)) {
          if (await local.mark(scope, state.localEtag, (r) => ({ ...r, pending: false }))) state.pending = false;
        } else {
          // the NAS had files this session has not seen: this browser's copy takes them (ScopeSync's next save meets the
          // new version, merges and gives them to Java)
          const result = await local.save(scope, toLocal, state.localEtag, { pending: false });
          if ('etag' in result) {
            state.localEtag = result.etag;
            state.local = toLocal;
            state.pending = false;
          }
        }
      }
    } catch (e) {
      log(`BD-J storage: ${scope} is on the NAS, but this browser's copy could not be marked so (${messageOf(e)}); it is put again at the next open`, true);
    }
    await this.dropLegacy(scope, state);
  }

  /** A put of every pending scope NAS_PUSH_DEBOUNCE_MS after the last save (NAS_PUSH_MAX_WAIT_MS after the first). */
  private schedule(): void {
    const { setTimer } = this.deps;
    this.cancelDebounce?.();
    this.cancelDebounce = setTimer(this.deps.pushDebounceMs ?? NAS_PUSH_DEBOUNCE_MS, () => {
      this.cancelDebounce = null;
      void this.flush();
    });
    this.cancelMaxWait ??= setTimer(this.deps.pushMaxWaitMs ?? NAS_PUSH_MAX_WAIT_MS, () => {
      this.cancelMaxWait = null;
      void this.flush();
    });
  }

  /** A put as soon as the boot's loads are through (a pending copy from the last session). */
  private soon(): void {
    this.cancelDebounce?.();
    this.cancelDebounce = this.deps.setTimer(0, () => {
      this.cancelDebounce = null;
      void this.flush();
    });
  }

  private retryLater(): void {
    this.cancelRetry ??= this.deps.setTimer(this.deps.retryMs ?? NAS_PUSH_RETRY_MS, () => {
      this.cancelRetry = null;
      void this.flush();
    });
  }
}

export interface NasDiscStoreDeps {
  readonly nas: NasBdjStore;
  readonly idb: IDBFactory;
  /** The disc's id on its server (manifest.discId): the source of its browser-only records (`nas:<discId>`). */
  readonly discId: string;
  readonly setTimer: SetTimer;
  readonly log: Log;
  readonly onFull?: (scope: string, full: boolean) => void;
  readonly loadBudgetMs?: number;
}

/**
 * The store of a disc opened from a server (the backend choice): the person's NAS store with its write-ahead copy
 * (WriteAheadNasStore) when the server says whose device this is; this browser only (`nas:<discId>`, as before) when
 * it keeps no people (the dev disc server); none when it does not answer (each scope then lasts the session, logged).
 */
export class NasDiscStore implements BdjStore {
  readonly saveDebounceMs = IDB_SAVE_DEBOUNCE_MS;
  private readonly backend: Promise<BdjStore>;
  private readonly budget: Promise<never>;

  constructor(private readonly deps: NasDiscStoreDeps) {
    const ms = deps.loadBudgetMs ?? NAS_LOAD_BUDGET_MS;
    this.budget = new Promise<never>((_, reject) => deps.setTimer(ms, () => reject(new NasStoreError(null, `the NAS did not answer within ${ms / 1000} s`))));
    this.budget.catch(() => undefined);
    this.backend = this.choose();
    this.backend.catch(() => undefined); // each load reports it
  }

  private async choose(): Promise<BdjStore> {
    const { nas, idb, discId, setTimer, log, onFull } = this.deps;
    let me: Awaited<ReturnType<NasBdjStore['me']>>;
    try {
      me = await within(nas.me(), this.budget);
    } catch (e) {
      log(`BD-J storage: the NAS did not say whose device this is (${messageOf(e)}); saved data lasts until BD-J stops`, true);
      throw e;
    }
    const legacy = new IdbBdjStore(`nas:${discId}`, idb);
    if (me === null) {
      log('BD-J storage: the disc server keeps no saved data per person; this browser keeps it');
      return legacy;
    }
    return new WriteAheadNasStore({
      nas,
      local: new IdbBdjStore(personSource(me.personId), idb),
      legacy,
      personId: me.personId,
      setTimer,
      log,
      budget: this.budget,
      ...(onFull ? { onFull } : {}),
    });
  }

  async load(scope: string): Promise<LoadedSnapshot> {
    return (await this.backend).load(scope);
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    return (await this.backend).save(scope, snapshot, etag);
  }

  async flush(): Promise<void> {
    let backend: BdjStore;
    try {
      backend = await this.backend;
    } catch {
      return; // nothing was loaded, so nothing is kept
    }
    await backend.flush?.();
  }
}
