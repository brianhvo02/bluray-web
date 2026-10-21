import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTar, writeTar as serverWriteTar } from '../../../../server/src/tar';
import { createDiscHandler, discApiBase, findDiscs } from '../../../../tools/disc-server/server';
import { startStoreNas, type StoreNas } from '../../../../tests/helpers/store-nas';
import { NasQuotaError, SCOPE_QUOTA_BYTES, type Snapshot, type SnapshotFile } from './bdj-store';
import { IdbBdjStore } from './idb-store';
import { NAS_PUSH_DEBOUNCE_MS, NAS_PUSH_RETRY_MS, PERSON_HEADER, NasBdjStore, NasDiscStore, WriteAheadNasStore, personSource, storeApiBase } from './nas-store';
import { readTar, tarPathFits, writeTar } from './tar';

// Every name here is made up.

const ORG = '7fff0002';
const SCOPE = `persistent/${ORG}`;
const BUDA = `buda/${ORG}/${'ab'.repeat(16)}`;
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const file = (path: string, mtime: number, s: string): SnapshotFile => ({ path, mtime, bytes: text(s) });
const view = (s: { files: readonly SnapshotFile[] }): [string, number, string][] => s.files.map((f) => [f.path, f.mtime, new TextDecoder().decode(f.bytes)]);

/** Timers run by hand: advance() fires those due, in order, and lets the promises they start settle. */
class Timers {
  private now = 0;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private n = 0;
  readonly setTimer = (ms: number, fn: () => void): (() => void) => {
    const id = ++this.n;
    this.queue.push({ at: this.now + ms, fn, id });
    return () => void (this.queue = this.queue.filter((t) => t.id !== id));
  };
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > until) break;
      this.queue.shift();
      this.now = next.at;
      next.fn();
      await settle();
    }
    this.now = until;
    await settle();
  }
}

/** Lets I/O (the NAS on a socket, fake IndexedDB) and the promises it settles run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

let nas: StoreNas;
beforeEach(async () => {
  nas = await startStoreNas({ scopeLimit: 64 * 1024, personLimit: 160 * 1024 });
});
afterEach(async () => {
  await nas.close();
});

const client = (token: string, refreshToken?: () => Promise<string>): NasBdjStore =>
  new NasBdjStore(nas.api, { fetch: nas.fetch, token, ...(refreshToken ? { refreshToken } : {}), sleep: async () => undefined });

describe('the NAS snapshot format (ustar, the NAS store contract)', () => {
  it('writes POSIX ustar headers the server accepts: regular files, mtimes in whole seconds, long paths split', () => {
    const long = `${'d'.repeat(120)}/${'f'.repeat(90)}`;
    const files = [file('4001/count', 1_700_000_000_999, '3'), file(long, 1_700_000_001_000, 'x')];
    const tar = writeTar(files);
    expect(new TextDecoder().decode(tar.subarray(257, 265))).toBe('ustar\u000000');
    expect(String.fromCharCode(tar[156]!)).toBe('0');
    expect(listTar(Buffer.from(tar))).toEqual([
      { path: '4001/count', size: 1, mtime: 1_700_000_000 },
      { path: long, size: 1, mtime: 1_700_000_001 },
    ]);
    expect(view({ files: readTar(tar) })).toEqual([['4001/count', 1_700_000_000_000, '3'], [long, 1_700_000_001_000, 'x']]);
    expect(writeTar([])).toEqual(new Uint8Array(1024)); // the empty archive: two zero blocks
  });

  it("reads the server's own archives, and knows which paths cannot be one", () => {
    const tar = serverWriteTar([{ path: 'a/b', data: Buffer.from('hi'), mtime: 1_600_000_000 }]);
    expect(view({ files: readTar(new Uint8Array(tar)) })).toEqual([['a/b', 1_600_000_000_000, 'hi']]);
    expect(tarPathFits(`${'x'.repeat(150)}/${'y'.repeat(104)}`)).toBe(false); // 255 bytes, but a name of 104
    expect(tarPathFits(`${'x'.repeat(154)}/${'y'.repeat(100)}`)).toBe(true);
    expect(tarPathFits('z'.repeat(256))).toBe(false);
    expect(tarPathFits('a/./b')).toBe(false);
  });
});

describe('NasBdjStore (the NAS store API)', () => {
  it('answers an empty snapshot with no etag, creates with If-None-Match: *, and round-trips under the quoted ETag', async () => {
    const { token } = await nas.person('Mika');
    const store = client(token);
    expect(await store.load(SCOPE)).toEqual({ files: [], etag: null });
    const saved = await store.save(SCOPE, { files: [file('4001/count', 1_700_000_000_500, '1')] }, null);
    expect(saved).toEqual({ etag: expect.stringMatching(/^"[^"]+"$/) });
    const loaded = await store.load(SCOPE);
    expect(loaded.etag).toBe('etag' in saved ? saved.etag : null);
    expect(view(loaded)).toEqual([['4001/count', 1_700_000_000_000, '1']]);
  });

  it("answers a 412 as a conflict with what the NAS holds now: a stale etag, or a create over a snapshot", async () => {
    const { personId, token } = await nas.person('Mika');
    const store = client(token);
    const first = await store.save(SCOPE, { files: [file('a', 1_000, 'one')] }, null);
    const second = await store.save(SCOPE, { files: [file('a', 2_000, 'two')] }, 'etag' in first ? first.etag : null);
    expect('etag' in second).toBe(true);
    const stale = await store.save(SCOPE, { files: [file('a', 3_000, 'three')] }, 'etag' in first ? first.etag : null);
    expect(stale).toEqual({ conflict: { files: [{ path: 'a', mtime: 2_000, bytes: text('two') }], etag: 'etag' in second ? second.etag : null } });
    const create = await store.save(SCOPE, { files: [] }, null);
    expect('conflict' in create && create.conflict.etag).toBe('etag' in second ? second.etag : null);
    expect(listTar(nas.stored(personId, SCOPE).body).map((e) => e.path)).toEqual(['a']);
  });

  it("throws NasQuotaError over the scope's or the person's quota (507), and the NAS keeps what it had", async () => {
    const { personId, token } = await nas.person('Mika');
    const store = client(token);
    const big = (n: number): Snapshot => ({ files: [file('big', 1_000, 'x'.repeat(n))] });
    await expect(store.save(SCOPE, big(70 * 1024), null)).rejects.toMatchObject({ name: 'NasQuotaError', limit: 'scope' });
    expect(nas.stored(personId, SCOPE).etag).toBeNull();
    expect((await store.save(SCOPE, big(60 * 1024), null)) as object).toHaveProperty('etag');
    expect((await store.save(BUDA, big(60 * 1024), null)) as object).toHaveProperty('etag');
    const third = store.save(`buda/${ORG}`, big(60 * 1024), null);
    await expect(third).rejects.toBeInstanceOf(NasQuotaError);
    await expect(third).rejects.toMatchObject({ limit: 'person', message: expect.stringContaining('No space left on device') });
  });

  it('tries a busy scope again (503, Retry-After: 1), and a stale token once with a fresh one (401)', async () => {
    const { personId, token } = await nas.person('Mika');
    const fresh = await nas.device(personId, 'tablet');
    let refreshes = 0;
    const store = client(token, async () => (refreshes++, fresh));
    nas.fail('busy', 'busy');
    expect(await store.save(SCOPE, { files: [file('a', 1_000, '1')] }, null)).toHaveProperty('etag');
    nas.expire(token);
    const loaded = await store.load(SCOPE);
    expect(view(loaded)).toEqual([['a', 1_000, '1']]);
    expect(refreshes).toBe(1);
    // with no way to refresh, a 401 is unpaired
    nas.expire(fresh);
    await expect(client(fresh).load(SCOPE)).rejects.toMatchObject({ status: 401 });
  });

  it("keeps each person's store to their own devices", async () => {
    const mika = await nas.person('Mika');
    const sora = await nas.person('Sora');
    const mikasTablet = await nas.device(mika.personId, 'tablet');
    await client(mika.token).save(SCOPE, { files: [file('4001/count', 1_000, '5')] }, null);
    expect(view(await client(mikasTablet).load(SCOPE))).toEqual([['4001/count', 1_000, '5']]);
    expect(await client(sora.token).load(SCOPE)).toEqual({ files: [], etag: null });
    expect(await client(sora.token).me()).toEqual({ personId: sora.personId, personName: 'Sora' });
  });

  it("takes a scope whose archive is exactly 16 MiB and refuses one block more here, without the NAS's 507 (ruling R24)", async () => {
    const big = await startStoreNas(); // the server's own limits
    try {
      const { personId, token } = await big.person('Mika');
      const store = new NasBdjStore(big.api, { fetch: big.fetch, token });
      const exact = SCOPE_QUOTA_BYTES - 512 - 1024; // one file: its header, its data, the end blocks
      const atLimit: Snapshot = { files: [file('f', 1_000, '')].map((f) => ({ ...f, bytes: new Uint8Array(exact) })) };
      expect(writeTar(atLimit.files).length).toBe(SCOPE_QUOTA_BYTES);
      expect(await store.save(SCOPE, atLimit, null)).toHaveProperty('etag');
      expect(big.stored(personId, SCOPE).body.length).toBe(SCOPE_QUOTA_BYTES);
      const sent = big.requests.length;
      const over: Snapshot = { files: [{ path: 'f', mtime: 2_000, bytes: new Uint8Array(exact + 1) }] };
      await expect(store.save(BUDA, over, null)).rejects.toMatchObject({ name: 'NasQuotaError', limit: 'scope' });
      expect(big.requests.length).toBe(sent); // refused here: no request, no 507
    } finally {
      await big.close();
    }
  });

  it('derives the API base from a disc base', () => {
    expect(storeApiBase('https://nas.example/bluray/api/discs/d1/')).toBe('https://nas.example/bluray/api/');
    expect(storeApiBase('rtc://n1/api/discs/abc/')).toBe('rtc://n1/api/');
    expect(storeApiBase('https://nas.example/other/')).toBeNull();
  });
});

describe('WriteAheadNasStore (ruling R17)', () => {
  interface Device {
    readonly store: WriteAheadNasStore;
    readonly local: IdbBdjStore;
    readonly logs: [string, boolean][];
    readonly full: [string, boolean][];
  }
  let timers: Timers;
  beforeEach(() => {
    timers = new Timers();
  });

  /** One BD-J session of a device: a store over the device's IndexedDB (`idb`), as a boot makes it. */
  const session = (personId: string, token: string, idb: IDBFactory, legacy?: IdbBdjStore, fetchHook?: typeof fetch): Device => {
    const logs: [string, boolean][] = [];
    const full: [string, boolean][] = [];
    const local = new IdbBdjStore(personSource(personId), idb);
    const nasClient = new NasBdjStore(nas.api, { fetch: fetchHook ?? nas.fetch, token, sleep: async () => undefined });
    nasClient.setPerson(personId);
    const store = new WriteAheadNasStore({
      nas: nasClient,
      local,
      legacy: legacy ?? null,
      personId,
      whoAmI: async () => (await client(token).me())?.personId ?? null,
      setTimer: timers.setTimer,
      log: (line, error) => logs.push([line, error ?? false]),
      onFull: (scope, f) => full.push([scope, f]),
    });
    return { store, local, logs, full };
  };
  const onNas = (personId: string, scope = SCOPE): [string, number][] => listTar(nas.stored(personId, scope).body).map((e) => [e.path, e.mtime]);

  it('saves to IndexedDB at once, marked pending, and puts it on the NAS 2 s after the last save', async () => {
    const { personId, token } = await nas.person('Mika');
    const d = session(personId, token, new IDBFactory());
    const loaded = await d.store.load(SCOPE);
    const saved = await d.store.save(SCOPE, { files: [file('4001/count', 1_700_000_000_000, '1')] }, loaded.etag);
    expect(saved).toHaveProperty('etag');
    expect(d.store.saveDebounceMs).toBe(100);
    expect((await d.local.loadRecord(SCOPE))?.pending).toBe(true);
    await timers.advance(NAS_PUSH_DEBOUNCE_MS - 100);
    expect(nas.stored(personId, SCOPE).etag).toBeNull();
    await timers.advance(100);
    expect(onNas(personId)).toEqual([['4001/count', 1_700_000_000]]);
    const rec = await d.local.loadRecord(SCOPE);
    expect(rec?.pending).toBe(false);
    expect(rec?.etag).toBe('etag' in saved ? saved.etag : null); // marked, not a new version: ScopeSync's next save goes through
    expect(d.logs).toContainEqual([`BD-J storage: ${SCOPE} is on the NAS (1 files, 1 bytes)`, false]);
  });

  it('a page closed before the NAS put loses nothing: the next boot merges the pending copy with the NAS and puts it', async () => {
    const { personId, token } = await nas.person('Mika');
    const tablet = await nas.device(personId, 'tablet');
    const phoneDb = new IDBFactory();
    // the tablet saved a file meanwhile
    await client(tablet).save(SCOPE, { files: [file('4001/other', 1_700_000_005_000, 'tablet')] }, null);
    const first = session(personId, token, phoneDb);
    const loaded = await first.store.load(SCOPE);
    expect(view(loaded)).toEqual([['4001/other', 1_700_000_005_000, 'tablet']]);
    await first.store.save(SCOPE, { files: [...loaded.files, file('4001/count', 1_700_000_010_000, '1')] }, loaded.etag);
    // the page goes 0.5 s later: no put yet
    await timers.advance(500);
    expect(onNas(personId)).toEqual([['4001/other', 1_700_000_005]]);

    timers = new Timers();
    const next = session(personId, token, phoneDb);
    const reloaded = await next.store.load(SCOPE);
    expect(view(reloaded)).toEqual([['4001/count', 1_700_000_010_000, '1'], ['4001/other', 1_700_000_005_000, 'tablet']]);
    await timers.advance(0);
    expect(onNas(personId)).toEqual([['4001/count', 1_700_000_010], ['4001/other', 1_700_000_005]]);
    expect((await next.local.loadRecord(SCOPE))?.pending).toBe(false);
  });

  it('merges per file by mtime on a 412 from another device of the person: no file lost, the newer wins, ties ours', async () => {
    const { personId, token } = await nas.person('Mika');
    const tabletToken = await nas.device(personId, 'tablet');
    const phone = session(personId, token, new IDBFactory());
    const tablet = session(personId, tabletToken, new IDBFactory());
    const p0 = await phone.store.load(SCOPE);
    const t0 = await tablet.store.load(SCOPE);
    // both start from nothing; each saves its own file and the same one, the tablet's later
    await phone.store.save(SCOPE, { files: [file('phone', 1_000_000, 'p'), file('shared', 2_000_400, 'phone'), file('tie', 3_000_100, 'phone')] }, p0.etag);
    await tablet.store.save(SCOPE, { files: [file('shared', 2_001_000, 'tablet'), file('tablet', 1_000_000, 't'), file('tie', 3_000_900, 'tablet')] }, t0.etag);
    await phone.store.flush();
    await tablet.store.flush(); // 412: merged with the phone's, then put
    expect(onNas(personId)).toEqual([['phone', 1_000], ['shared', 2_001], ['tablet', 1_000], ['tie', 3_000]]);
    const reread = await client(token).load(SCOPE);
    expect(view(reread).map(([p, , s]) => [p, s])).toEqual([['phone', 'p'], ['shared', 'tablet'], ['tablet', 't'], ['tie', 'tablet']]);
    // the tablet's copy takes the phone's file: a new version, which ScopeSync's next save merges into Java's files
    const rec = await tablet.local.loadRecord(SCOPE);
    expect(rec?.files.map((f) => f.path)).toEqual(['phone', 'shared', 'tablet', 'tie']);
    expect(rec?.pending).toBe(false);
  });

  it('keeps a save the NAS does not take (unreachable), logs it, and puts it later', async () => {
    const { personId, token } = await nas.person('Mika');
    const d = session(personId, token, new IDBFactory());
    const loaded = await d.store.load(SCOPE);
    await d.store.save(SCOPE, { files: [file('a', 5_000, '1')] }, loaded.etag);
    nas.failPut('unreachable', 'unreachable'); // with X-Bdj-Person, then without it
    await timers.advance(NAS_PUSH_DEBOUNCE_MS);
    expect(d.logs).toContainEqual([`BD-J storage: ${SCOPE} could not be put on the NAS (the NAS could not be reached (fetch failed)); this browser keeps it and tries again`, true]);
    expect(d.store.pendingScopes()).toEqual([SCOPE]);
    expect((await d.local.loadRecord(SCOPE))?.pending).toBe(true);
    await timers.advance(NAS_PUSH_RETRY_MS);
    expect(onNas(personId)).toEqual([['a', 5]]);
    expect(d.store.pendingScopes()).toEqual([]);
  });

  it("puts nothing while the NAS does not say whose device this is (logged), and puts it once it does", async () => {
    const { personId, token } = await nas.person('Mika');
    const d = session(personId, token, new IDBFactory());
    const loaded = await d.store.load(SCOPE);
    await d.store.save(SCOPE, { files: [file('a', 5_000, '1')] }, loaded.etag);
    nas.fail('unreachable'); // the `me` before the put
    await timers.advance(NAS_PUSH_DEBOUNCE_MS);
    expect(d.logs).toContainEqual(['BD-J storage: the NAS did not say whose device this is (the NAS could not be reached (fetch failed)); saved data is put on the NAS later', true]);
    expect(nas.stored(personId, SCOPE).etag).toBeNull();
    await timers.advance(NAS_PUSH_RETRY_MS);
    expect(onNas(personId)).toEqual([['a', 5]]);
  });

  it("loads this browser's copy when the NAS does not answer, and nothing when there is none", async () => {
    const { personId, token } = await nas.person('Mika');
    const idb = new IDBFactory();
    const d = session(personId, token, idb);
    const loaded = await d.store.load(SCOPE);
    await d.store.save(SCOPE, { files: [file('a', 5_000, '1')] }, loaded.etag);
    await d.store.flush();
    nas.fail('unreachable', 'unreachable');
    const again = session(personId, token, idb);
    expect(view(await again.store.load(SCOPE))).toEqual([['a', 5_000, '1']]);
    expect(again.logs[0]![1]).toBe(true);
    await expect(again.store.load(BUDA)).rejects.toThrow('could not be reached');
    expect(again.logs.at(-1)).toEqual([`BD-J storage: ${BUDA} could not be loaded from the NAS (the NAS could not be reached (fetch failed)), and this browser has no copy`, true]);
  });

  it('tells Java the scope is full on a 507 (onFull), and has room again once the NAS takes it', async () => {
    const { personId, token } = await nas.person('Mika');
    const d = session(personId, token, new IDBFactory());
    const loaded = await d.store.load(SCOPE);
    const saved = await d.store.save(SCOPE, { files: [file('big', 5_000, 'x'.repeat(70 * 1024))] }, loaded.etag);
    await d.store.flush();
    expect(d.full).toEqual([[SCOPE, true]]);
    expect(d.logs.some(([l, e]) => e && l.includes('was not put on the NAS') && l.includes('No space left on device'))).toBe(true);
    expect((await d.local.loadRecord(SCOPE))?.pending).toBe(true); // kept here
    await d.store.save(SCOPE, { files: [file('big', 6_000, 'x'.repeat(10))] }, 'etag' in saved ? saved.etag : null);
    await d.store.flush();
    expect(d.full).toEqual([[SCOPE, true], [SCOPE, false]]);
    expect(onNas(personId)).toEqual([['big', 6]]);
  });

  it('moves a NAS disc\'s browser-only saves into the person\'s scopes once, removing them only once the NAS has them', async () => {
    const { personId, token } = await nas.person('Mika');
    const idb = new IDBFactory();
    const legacy = new IdbBdjStore('nas:disc1', idb);
    await legacy.save(SCOPE, { files: [file('4001/count', 1_600_000_000_000, '7')] }, null);
    const first = session(personId, token, idb, legacy);
    const loaded = await first.store.load(SCOPE);
    expect(view(loaded)).toEqual([['4001/count', 1_600_000_000_000, '7']]);
    // merged into the person's write-ahead copy and marked; still there until the NAS has it
    expect((await first.local.loadRecord(SCOPE))?.pending).toBe(true);
    expect((await legacy.loadRecord(SCOPE))?.migratedTo).toBe(personId);
    await timers.advance(0);
    expect(onNas(personId)).toEqual([['4001/count', 1_600_000_000]]);
    expect(await legacy.loadRecord(SCOPE)).toBeNull();
    expect(first.logs.map(([l]) => l)).toContain(`BD-J storage: ${SCOPE}: the NAS has this browser's old saved data; the old copy is removed`);
  });

  it('keeps the old browser copy while the NAS has not confirmed, and does not move it twice', async () => {
    const { personId, token } = await nas.person('Mika');
    const idb = new IDBFactory();
    const legacy = new IdbBdjStore('nas:disc1', idb);
    await legacy.save(SCOPE, { files: [file('4001/count', 1_600_000_000_000, '7')] }, null);
    const first = session(personId, token, idb, legacy);
    await first.store.load(SCOPE);
    nas.fail('unreachable');
    await timers.advance(0); // the put fails
    expect((await legacy.loadRecord(SCOPE))?.migratedTo).toBe(personId);
    expect(nas.stored(personId, SCOPE).etag).toBeNull();

    timers = new Timers();
    const next = session(personId, token, idb, legacy);
    const loaded = await next.store.load(SCOPE);
    expect(view(loaded)).toEqual([['4001/count', 1_600_000_000_000, '7']]);
    expect(next.logs.some(([l]) => l.includes('moves to the NAS'))).toBe(false); // merged before: not again
    await timers.advance(0);
    expect(onNas(personId)).toEqual([['4001/count', 1_600_000_000]]);
    expect(await legacy.loadRecord(SCOPE)).toBeNull();
  });
  it("never puts one person's saves in another's store when the device moves mid-session (412 path)", async () => {
    const mika = await nas.person('Mika');
    const sora = await nas.person('Sora');
    await client(sora.token).save(SCOPE, { files: [file('sora-only', 9_000_000, 'sora')] }, null);
    const d = session(mika.personId, mika.token, new IDBFactory());
    const loaded = await d.store.load(SCOPE);
    const first = await d.store.save(SCOPE, { files: [file('mika-only', 5_000_000, 'mika')] }, loaded.etag);
    await d.store.flush();
    expect(onNas(mika.personId)).toEqual([['mika-only', 5_000]]);
    // the owner moves the device to Sora: its token now reaches Sora's store, whose etag differs (a 412)
    nas.move(mika.deviceId, sora.personId);
    await d.store.save(SCOPE, { files: [file('mika-only', 6_000_000, 'mika 2')] }, 'etag' in first ? first.etag : null);
    await d.store.flush();
    await timers.advance(NAS_PUSH_RETRY_MS);
    expect(onNas(sora.personId)).toEqual([['sora-only', 9_000]]);
    expect(onNas(mika.personId)).toEqual([['mika-only', 5_000]]);
    const rec = await d.local.loadRecord(SCOPE);
    expect(rec?.files.map((f) => f.path)).toEqual(['mika-only']); // Sora's file never came into Mika's copy
    expect(rec?.pending).toBe(true); // kept here, for Mika
    expect(d.logs.filter(([l, e]) => e && l.includes('now belongs to another person'))).toHaveLength(1);
  });

  it("does not create the other person's scope either (a first put after the move, If-None-Match: *)", async () => {
    const mika = await nas.person('Mika');
    const sora = await nas.person('Sora');
    const d = session(mika.personId, mika.token, new IDBFactory());
    const loaded = await d.store.load(SCOPE);
    await d.store.save(SCOPE, { files: [file('mika-only', 5_000_000, 'mika')] }, loaded.etag);
    nas.move(mika.deviceId, sora.personId);
    await timers.advance(NAS_PUSH_DEBOUNCE_MS);
    expect(nas.stored(sora.personId, SCOPE).etag).toBeNull();
    expect(nas.stored(mika.personId, SCOPE).etag).toBeNull();
    expect(d.store.pendingScopes()).toEqual([SCOPE]);
  });

  it('keeps the boot merge in the write-ahead copy before the put marks it as on the NAS', async () => {
    const { personId, token } = await nas.person('Mika');
    const tablet = await nas.device(personId, 'tablet');
    const idb = new IDBFactory();
    const first = session(personId, token, idb);
    const l0 = await first.store.load(SCOPE);
    await first.store.save(SCOPE, { files: [file('phone', 1_000_000, 'p')] }, l0.etag); // left pending (page closed)
    await client(tablet).save(SCOPE, { files: [file('tablet', 2_000_000, 't')] }, null);
    timers = new Timers();
    const next = session(personId, token, idb);
    const loaded = await next.store.load(SCOPE);
    expect(view(loaded).map(([p]) => p)).toEqual(['phone', 'tablet']);
    await timers.advance(0);
    const rec = await next.local.loadRecord(SCOPE);
    expect([rec?.pending, rec?.etag, rec?.files.map((f) => f.path)]).toEqual([false, loaded.etag, ['phone', 'tablet']]);
  });
  /** A fetch that moves the device (to `to`) as the next PUT leaves: after the check before it, before the server sees it. */
  const moveOnPut = (deviceId: string, to: () => string): { fetch: typeof fetch; armed: { on: boolean } } => {
    const armed = { on: false };
    const hook = ((input: string | URL | Request, init?: RequestInit) => {
      if (armed.on && (init?.method ?? 'GET').toUpperCase() === 'PUT') {
        armed.on = false;
        nas.move(deviceId, to());
      }
      return nas.fetch(input, init);
    }) as typeof fetch;
    return { fetch: hook, armed };
  };

  it("loads only this browser's copy when the device moved before the boot's GET: the other person's snapshot is never taken", async () => {
    const mika = await nas.person('Mika');
    const sora = await nas.person('Sora');
    await client(sora.token).save(SCOPE, { files: [file('sora-only', 9_000_000, 'sora')] }, null);
    const idb = new IDBFactory();
    await new IdbBdjStore(personSource(mika.personId), idb).save(SCOPE, { files: [file('mika-only', 5_000_000, 'mika')] }, null, { pending: true });
    nas.move(mika.deviceId, sora.personId); // after the boot's `me`, before this scope's GET
    const d = session(mika.personId, mika.token, idb);
    const loaded = await d.store.load(SCOPE);
    expect(view(loaded).map(([p]) => p)).toEqual(['mika-only']);
    await timers.advance(NAS_PUSH_RETRY_MS);
    const rec = await d.local.loadRecord(SCOPE);
    expect([rec?.pending, rec?.files.map((f) => f.path)]).toEqual([true, ['mika-only']]);
    expect(onNas(sora.personId)).toEqual([['sora-only', 9_000]]);
    expect(d.logs.filter(([l, e]) => e && l.includes('now belongs to another person'))).toHaveLength(1);
  });

  it('acts on a 412 only for the same person: a move between the check and the PUT never merges the other store', async () => {
    const mika = await nas.person('Mika');
    const sora = await nas.person('Sora');
    await client(sora.token).save(SCOPE, { files: [file('sora-only', 9_000_000, 'sora')] }, null);
    const hook = moveOnPut(mika.deviceId, () => sora.personId);
    const d = session(mika.personId, mika.token, new IDBFactory(), undefined, hook.fetch);
    const loaded = await d.store.load(SCOPE);
    const first = await d.store.save(SCOPE, { files: [file('mika-only', 5_000_000, 'mika')] }, loaded.etag);
    await d.store.flush(); // on Mika's NAS: Mika's etag from now on
    hook.armed.on = true;
    await d.store.save(SCOPE, { files: [file('mika-only', 6_000_000, 'mika 2')] }, 'etag' in first ? first.etag : null);
    await d.store.flush(); // the check passes, the PUT reaches Sora's store with Mika's etag: 412
    expect(hook.armed.on).toBe(false);
    expect(onNas(sora.personId)).toEqual([['sora-only', 9_000]]);
    expect(onNas(mika.personId)).toEqual([['mika-only', 5_000]]);
    const rec = await d.local.loadRecord(SCOPE);
    expect([rec?.pending, rec?.files.map((f) => f.path)]).toEqual([true, ['mika-only']]);
    expect(d.logs.filter(([l, e]) => e && l.includes('now belongs to another person'))).toHaveLength(1);
  });

  it('does not mark the copy as on the NAS when the PUT went through after a move (a NAS without the guard)', async () => {
    const mika = await nas.person('Mika');
    const sora = await nas.person('Sora');
    const hook = moveOnPut(mika.deviceId, () => sora.personId);
    const d = session(mika.personId, mika.token, new IDBFactory(), undefined, hook.fetch);
    const loaded = await d.store.load(SCOPE);
    await d.store.save(SCOPE, { files: [file('mika-only', 5_000_000, 'mika')] }, loaded.etag);
    hook.armed.on = true;
    await d.store.flush(); // If-None-Match: * on Sora's empty scope: a server without the guard takes it (its 409 would not)
    expect((await d.local.loadRecord(SCOPE))?.pending).toBe(true); // kept for Mika, never marked
    expect(d.store.pendingScopes()).toEqual([SCOPE]);
    expect(d.logs.some(([l]) => l.includes('is on the NAS'))).toBe(false);
    expect(d.logs.filter(([l, e]) => e && l.includes('now belongs to another person'))).toHaveLength(1);
  });

  it("takes the guard's 409 person-changed as a move: kept pending, never marked, nothing more put", async () => {
    const mika = await nas.person('Mika');
    const headers: (string | null)[] = [];
    let puts = 0;
    const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() !== 'PUT') return nas.fetch(input, init);
      puts++;
      headers.push(new Headers(init?.headers).get(PERSON_HEADER));
      return Response.json({ error: 'person-changed' }, { status: 409 });
    }) as typeof fetch;
    const d = session(mika.personId, mika.token, new IDBFactory(), undefined, guarded);
    const loaded = await d.store.load(SCOPE);
    await d.store.save(SCOPE, { files: [file('a', 5_000_000, '1')] }, loaded.etag);
    await d.store.flush();
    await d.store.flush();
    expect(puts).toBe(1);
    expect(headers).toEqual([mika.personId]);
    expect((await d.local.loadRecord(SCOPE))?.pending).toBe(true);
    expect(d.logs.filter(([l, e]) => e && l.includes('the NAS refused the write'))).toHaveLength(1);
  });

  it('never sends a write without X-Bdj-Person once the NAS has taken one with it (ruling R25): a failure is then the network\'s', async () => {
    const mika = await nas.person('Mika');
    const sent: (string | null)[] = [];
    let down = false;
    const flaky = ((input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
        sent.push(new Headers(init?.headers).get(PERSON_HEADER));
        if (down) return Promise.reject(new TypeError('Failed to fetch'));
      }
      return nas.fetch(input, init);
    }) as typeof fetch;
    // the API base as another NAS (the acceptance is kept per NAS for the session)
    const api = nas.api.replace('127.0.0.1', 'localhost');
    const store = new NasBdjStore(api, { fetch: flaky, token: mika.token });
    store.setPerson(mika.personId);
    const first = await store.save(SCOPE, { files: [file('a', 1_000, '1')] }, null);
    expect(sent).toEqual([mika.personId]);
    down = true;
    await expect(store.save(SCOPE, { files: [file('a', 2_000, '2')] }, 'etag' in first ? first.etag : null)).rejects.toMatchObject({ status: null });
    expect(sent).toEqual([mika.personId, mika.personId]); // no write without it
    // another client of the same NAS in this session knows it too
    const again = new NasBdjStore(api, { fetch: flaky, token: mika.token });
    again.setPerson(mika.personId);
    await expect(again.save(SCOPE, { files: [file('a', 3_000, '3')] }, 'etag' in first ? first.etag : null)).rejects.toMatchObject({ status: null });
    expect(sent).toEqual([mika.personId, mika.personId, mika.personId]);
    expect(onNas(mika.personId)).toEqual([['a', 1]]);
  });

  it('sends X-Bdj-Person on each write, and before the NAS has taken one, that write again without it when it cannot leave (an older server\'s CORS)', async () => {
    const mika = await nas.person('Mika');
    const sent: (string | null)[] = [];
    const corsOfOldServer = ((input: string | URL | Request, init?: RequestInit) => {
      const person = new Headers(init?.headers).get(PERSON_HEADER);
      if ((init?.method ?? 'GET').toUpperCase() === 'PUT') sent.push(person);
      if (person !== null) return Promise.reject(new TypeError('Failed to fetch')); // the preflight's refusal
      return nas.fetch(input, init);
    }) as typeof fetch;
    const logs: [string, boolean][] = [];
    const store = new NasBdjStore(nas.api, { fetch: corsOfOldServer, token: mika.token, log: (l, e) => logs.push([l, e ?? false]) });
    store.setPerson(mika.personId);
    const first = await store.save(SCOPE, { files: [file('a', 1_000, '1')] }, null);
    await store.save(SCOPE, { files: [file('a', 2_000, '2')] }, 'etag' in first ? first.etag : null);
    expect(sent).toEqual([mika.personId, null, mika.personId, null]); // each write tries the header first
    expect(onNas(mika.personId)).toEqual([['a', 2]]);
    expect(logs).toEqual([[`BD-J storage: a write with the ${PERSON_HEADER} header did not reach the NAS, and went without it (a server from before its guard)`, true]]);
  });
});

describe('NasDiscStore (the backend of a disc from a server)', () => {
  let discServer: Server | null = null;
  afterEach(async () => {
    discServer?.closeAllConnections();
    await new Promise<void>((resolve) => (discServer ? discServer.close(() => resolve()) : resolve()));
    discServer = null;
  });

  const discStore = (nasStore: NasBdjStore, idb: IDBFactory, timers: Timers, logs: string[] = []): NasDiscStore =>
    new NasDiscStore({ nas: nasStore, idb, discId: 'disc1', setTimer: timers.setTimer, log: (line) => logs.push(line) });

  it("keeps a NAS disc's saved data in the person's store, with the write-ahead copy under the person", async () => {
    const { personId, token } = await nas.person('Mika');
    const idb = new IDBFactory();
    const timers = new Timers();
    const store = discStore(client(token), idb, timers);
    const loaded = await store.load(SCOPE);
    await store.save(SCOPE, { files: [file('4001/count', 1_000, '1')] }, loaded.etag);
    await store.flush();
    expect(listTar(nas.stored(personId, SCOPE).body).map((e) => e.path)).toEqual(['4001/count']);
    expect((await new IdbBdjStore(personSource(personId), idb).loadRecord(SCOPE))?.pending).toBe(false);
    expect(await new IdbBdjStore('nas:disc1', idb).loadRecord(SCOPE)).toBeNull();
  });

  it('keeps it in this browser (nas:<discId>, as before) on a server with no people: the dev disc server', async () => {
    const root = fileURLToPath(new URL('../../../../fixtures/synthetic/', import.meta.url));
    const handler = createDiscHandler({ roots: [root], token: 't' });
    discServer = createServer(handler);
    await new Promise<void>((resolve) => discServer!.listen(0, '127.0.0.1', resolve));
    const id = findDiscs([root]).find((d) => d.name === 'disc-bdj-store')!.id;
    const api = storeApiBase(discApiBase(`http://127.0.0.1:${(discServer.address() as AddressInfo).port}`, id))!;
    const idb = new IDBFactory();
    const logs: string[] = [];
    const store = discStore(new NasBdjStore(api, { fetch, token: 't' }), idb, new Timers(), logs);
    const loaded = await store.load(SCOPE);
    await store.save(SCOPE, { files: [file('4001/count', 1_000, '1')] }, loaded.etag);
    await store.flush();
    expect((await new IdbBdjStore('nas:disc1', idb).load(SCOPE)).files.map((f) => f.path)).toEqual(['4001/count']);
    expect(logs).toContain('BD-J storage: the disc server keeps no saved data per person; this browser keeps it');
  });

  it('keeps nothing past the session when the NAS does not say whose device this is (logged)', async () => {
    const { token } = await nas.person('Mika');
    const logs: string[] = [];
    nas.fail('unreachable');
    const store = discStore(client(token), new IDBFactory(), new Timers(), logs);
    await expect(store.load(SCOPE)).rejects.toThrow('could not be reached');
    await store.flush();
    expect(logs).toEqual(["BD-J storage: the NAS did not say whose device this is (the NAS could not be reached (fetch failed)); saved data lasts until BD-J stops"]);
  });

  it("uses this browser's copy when the NAS has not answered within the boot's budget", async () => {
    const { personId, token } = await nas.person('Mika');
    const idb = new IDBFactory();
    await new IdbBdjStore(personSource(personId), idb).save(SCOPE, { files: [file('a', 1_000, 'here')] }, null, { pending: false });
    const timers = new Timers();
    // a NAS whose store GET never answers
    const slow = new NasBdjStore(nas.api, {
      fetch: ((input: string | URL | Request, init?: RequestInit) => (String(input).includes('/bdj-store/') ? new Promise<Response>(() => undefined) : nas.fetch(input, init))) as typeof fetch,
      token,
    });
    const logs: string[] = [];
    const store = discStore(slow, idb, timers, logs);
    const loading = store.load(SCOPE);
    await settle();
    await timers.advance(2500);
    expect(view(await loading)).toEqual([['a', 1_000, 'here']]);
    expect(logs.at(-1)).toContain("could not be loaded from the NAS (the NAS did not answer within 2.5 s); this browser's copy is used");
  });
});
