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
  NasQuotaError, SCOPE_QUOTA_BYTES, ScopeQuotaError, mergeSnapshots, sameSnapshot, snapshotBytes, sortFiles,
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

/**
 * The device is no longer the person a write was meant for (the NAS session's X-Bdj-Person guard answered 409
 * `person-changed`, or `GET me` named someone else before the write): nothing was written.
 */
export class PersonChangedError extends NasStoreError {
  constructor(message = 'this device now belongs to another person on the NAS') {
    super(409, message);
    this.name = 'PersonChangedError';
  }
}

/** The request header naming the person a write is for (the NAS store contract's X-Bdj-Person guard). */
export const PERSON_HEADER = 'X-Bdj-Person';

/**
 * The NAS APIs (by API base) that have answered a write carrying X-Bdj-Person (ruling R25): their CORS takes it, so a
 * write there that cannot leave is a network failure, never sent again without the header. Kept for the worker's
 * life (one BD-J session); see NasBdjStore.write.
 */
const personHeaderAccepted = new Set<string>();

/** Answers that prove a write carrying the header reached the server (its CORS let it through). */
const REACHED = (status: number): boolean => (status >= 200 && status < 300) || status === 409 || status === 412 || status === 507;

/** Per write, before each PUT is sent (503 retries included): throws (PersonChangedError) to send nothing. */
export interface SaveOptions {
  readonly beforePut?: () => Promise<void>;
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
  readonly log?: (line: string, error?: boolean) => void;
}

/**
 * The NAS store's HTTP API (`<api>bdj-store/<scope>`, `<api>me`), the token as `t=` as for the disc's reads. A scope
 * is a ustar snapshot under a quoted ETag, sent back exactly as received: PUT with `If-Match: "<etag>"`, or
 * `If-None-Match: *` when the NAS has none; a 412 answers what the NAS holds now, as a conflict; a 507 throws
 * NasQuotaError; a 503 is tried again after its Retry-After.
 */
export class NasBdjStore implements BdjStore {
  readonly saveDebounceMs = NAS_PUSH_DEBOUNCE_MS;
  readonly quotaAccounting = 'tar';
  private token: string;
  private refreshing: Promise<string> | null = null;
  /** Sent as X-Bdj-Person on every write once known (setPerson). */
  private person: string | null = null;
  /** The fallback without X-Bdj-Person was logged (once). */
  private headerFallbackLogged = false;

  constructor(
    readonly apiBase: string,
    private readonly deps: NasBdjStoreDeps,
  ) {
    this.token = deps.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  /** The person every write is for (X-Bdj-Person): a NAS with the guard refuses it (409) once the token is someone else's. */
  setPerson(personId: string): void {
    this.person = personId;
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

  async save(scope: string, snapshot: Snapshot, etag: string | null, opts: SaveOptions = {}): Promise<SaveResult> {
    const body = writeTar(snapshot.files);
    // the NAS refuses an archive over 16 MB (`>`, so exactly 16 MB is taken): refused here, without the 507's round trip
    if (body.length > SCOPE_QUOTA_BYTES) throw new NasQuotaError(scope, body.length, 'scope');
    const res = await this.send('PUT', `bdj-store/${scope}`, {
      'Content-Type': 'application/x-tar',
      ...(etag !== null ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
    }, body, opts.beforePut);
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
      case 409: {
        let error: unknown = null;
        try {
          error = ((await res.json()) as { error?: unknown }).error;
        } catch {
          // no JSON body
        }
        if (error === 'person-changed') throw new PersonChangedError(`${scope}: the NAS refused the write: this device now belongs to another person`);
        throw new NasStoreError(409, `${scope}: HTTP 409${typeof error === 'string' ? `: ${error}` : ''}`);
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
  private async send(
    method: 'GET' | 'PUT',
    path: string,
    headers: Record<string, string> = {},
    body?: Uint8Array<ArrayBuffer>,
    beforePut?: () => Promise<void>,
  ): Promise<Response> {
    let refreshed = false;
    for (let busy = 0; ; ) {
      const token = this.token;
      if (method === 'PUT') await beforePut?.();
      const res = await this.write(method, path, token, headers, body);
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

  /** A request, a write carrying X-Bdj-Person while the server takes it. */
  private async write(method: 'GET' | 'PUT', path: string, token: string, headers: Record<string, string>, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
    if (method === 'GET' || this.person === null) return this.request(method, path, token, headers, body);
    try {
      const res = await this.request(method, path, token, { ...headers, [PERSON_HEADER]: this.person }, body);
      if (REACHED(res.status)) personHeaderAccepted.add(this.apiBase);
      return res;
    } catch (e) {
      if (!(e instanceof NasStoreError) || e.status !== null) throw e;
      // this NAS has taken the header before: a write that cannot leave is the network's, kept pending and tried again
      // later with the header (ruling R25), never sent without it
      if (personHeaderAccepted.has(this.apiBase)) throw e;
      // unreachable with the header: a server from before the guard refuses it in CORS (the browser then sends nothing),
      // which a page cannot tell from a network failure. This one write goes again without it, right after the caller's
      // own check of whose device this is (beforePut); the next write tries the header first again, so a server with
      // the guard keeps it for every write that reaches it
      const res = await this.request(method, path, token, headers, body);
      if (!this.headerFallbackLogged) {
        this.headerFallbackLogged = true;
        this.deps.log?.(`BD-J storage: a write with the ${PERSON_HEADER} header did not reach the NAS, and went without it (a server from before its guard)`, true);
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
  readonly nas: Pick<NasBdjStore, 'load'> & { save(scope: string, snapshot: Snapshot, etag: string | null, opts?: SaveOptions): Promise<SaveResult> };
  /** This person's write-ahead copies (personSource). */
  readonly local: IdbBdjStore;
  /** The disc's browser-only records from before (`nas:<discId>`, scopes.ts storeSource), moved to the NAS once. */
  readonly legacy?: IdbBdjStore | null;
  readonly personId: string;
  /**
   * Whose device this is now (`GET me`'s personId; null when the server keeps no people), asked before each put and
   * before a 412 is merged: an owner can move a device to another person while BD-J runs, and the token then reaches
   * that person's store. Without it the person is the boot's for the whole session.
   */
  readonly whoAmI?: () => Promise<string | null>;
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
  readonly quotaAccounting = 'tar';
  /** The device now belongs to another person: nothing more is put on the NAS this session (its copies stay pending). */
  private moved = false;
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
    // the GET went with the token as it is now: if the device moved to another person since the boot asked, that is
    // their snapshot, never merged into this person's copy
    if (!(await this.samePerson())) {
      if (!this.moved && rec === null && legacyEtag === null) throw new NasStoreError(null, `${scope}: whose device this is could not be checked, and this browser has no copy`);
      return { files: state.local.files, etag };
    }
    state.nasEtag = remote.etag;
    if (pending) {
      // the last session's changes the NAS did not get: merged as on a 412 (newer mtime wins, ties ours) and put now
      const merged = mergeSnapshots(state.local, remote).merged;
      if (!sameSnapshot(merged, state.local)) {
        // the write-ahead copy holds the merge before anything marks it as on the NAS
        const result = await local.save(scope, merged, etag, { pending: true });
        if ('etag' in result) {
          etag = result.etag;
          state.localEtag = etag;
          state.local = merged;
        } else {
          log(`BD-J storage: ${scope}: this browser's copy changed while it loaded; its pending changes are put as they are`, true);
          etag = result.conflict.etag;
          // no version to mark: the record holds less than what is put, so it stays pending until ScopeSync saves
          state.localEtag = null;
          state.local = mergeSnapshots(result.conflict, remote).merged;
        }
      }
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
    if (![...this.scopes.values()].some((s) => s.pending)) return;
    if (!(await this.samePerson())) return;
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

  /**
   * Whether the device is still the boot's person's (whoAmI). When it is not, nothing more goes to the NAS: the copies
   * stay pending in this browser under the person they were written for (logged as an error once). A failed check is a
   * failed put (tried again later).
   */
  private async samePerson(): Promise<boolean> {
    if (this.moved) return false;
    if (!this.deps.whoAmI) return true;
    let now: string | null;
    try {
      now = await this.deps.whoAmI();
    } catch (e) {
      this.deps.log(`BD-J storage: the NAS did not say whose device this is (${messageOf(e)}); saved data is put on the NAS later`, true);
      this.retryLater();
      return false;
    }
    if (now === this.deps.personId) return true;
    this.personMoved();
    return false;
  }

  /** samePerson for a PUT about to go: throws PersonChangedError (or the check's failure) instead of answering false. */
  private async assertSamePerson(): Promise<void> {
    if (this.moved) throw new PersonChangedError();
    if (!this.deps.whoAmI) return;
    if ((await this.deps.whoAmI()) !== this.deps.personId) throw new PersonChangedError();
  }

  /** Nothing more goes to the NAS this session (logged as an error once). */
  private personMoved(detail?: string): void {
    if (this.moved) return;
    this.moved = true;
    this.deps.log(
      `BD-J storage: this device now belongs to another person on the NAS${detail ? ` (${detail})` : ''}; this session's saved data stays in this browser for the person it was written for, and is not put on the NAS`,
      true,
    );
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
        if (!(await this.samePerson())) return;
        state.nasEtag = remote.etag;
        snapshot = mergeSnapshots(snapshot, remote).merged;
      }
      for (let attempt = 1; ; attempt++) {
        // right before each PUT (503 retries too): still this person's device
        const result = await nas.save(scope, snapshot, state.nasEtag, { beforePut: () => this.assertSamePerson() });
        if ('etag' in result) {
          state.nasEtag = result.etag;
          break;
        }
        // another device of this person put it meanwhile, or the device has moved to another person (whose store the
        // token now reaches): never merged across people
        if (!(await this.samePerson())) return;
        // merged per file, newer mtime wins (whole seconds), ties ours
        snapshot = mergeSnapshots(snapshot, result.conflict).merged;
        state.nasEtag = result.conflict.etag;
        if (attempt >= PUSH_ATTEMPTS) throw new Error(`still changed elsewhere after ${attempt} tries`);
      }
    } catch (e) {
      if (e instanceof PersonChangedError) {
        // kept pending under the person it was written for; never marked as on the NAS
        this.personMoved(e.message);
        return;
      }
      if (e instanceof ScopeQuotaError) {
        // not retried on a timer: room comes back only when Java frees some (the next save) or elsewhere (the next
        // flush or boot puts it again)
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
    // a move between the last check and the PUT (a NAS without the guard takes it): not marked as on this person's NAS
    if (!(await this.samePerson())) return;
    log(`BD-J storage: ${scope} is on the NAS (${snapshot.files.length} files, ${snapshotBytes(snapshot)} bytes)`);
    try {
      if (state.gen === gen && state.localEtag !== null) {
        // the write-ahead copy as the NAS has it now: marked (no new version) when the merge added nothing to it
        const toLocal = mergeSnapshots(state.local, snapshot).merged;
        if (sameSnapshot(toLocal, state.local)) {
          if (await local.mark(scope, state.localEtag, (r) => ({ ...r, pending: false }))) state.pending = false;
        } else if (await this.samePerson()) {
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
  /**
   * Every disc from a server counts its quota as the NAS does (ruling R24), even on a server that keeps it in this
   * browser (the same discs move to a NAS later); a picked folder counts file lengths (IdbBdjStore).
   */
  readonly quotaAccounting = 'tar';
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
    nas.setPerson(me.personId);
    return new WriteAheadNasStore({
      nas,
      local: new IdbBdjStore(personSource(me.personId), idb),
      legacy,
      personId: me.personId,
      whoAmI: async () => (await nas.me())?.personId ?? null,
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
