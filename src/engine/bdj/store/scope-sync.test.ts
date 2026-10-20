import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vfs } from '../jvm/vfs';
import { ZipArchive } from '../jvm/zip';
import { ScopeQuotaError, type BdjStore, type LoadedSnapshot, type SaveResult, type Snapshot } from './bdj-store';
import { IdbBdjStore } from './idb-store';
import { SAVE_DEBOUNCE_MS, ScopeSync } from './scope-sync';
import type { StoreScope } from './scopes';

const rtBdj = ZipArchive.open(readFileSync(fileURLToPath(new URL('../../../bdj-classlib/rt-bdj.jar', import.meta.url))));
const enc = new TextEncoder();
const dec = new TextDecoder();

const PERSISTENT: StoreScope = { key: 'persistent/7fff0123', dir: '/persistent/7fff0123' };
const BUDA: StoreScope = { key: 'buda/7fff0123/88000000000000000000000000139561', dir: '/buda/7fff0123/88000000000000000000000000139561' };

/** A store in memory that records its saves; `hold` keeps loads waiting. */
class MemoryStore implements BdjStore {
  readonly scopes = new Map<string, { snapshot: Snapshot; etag: string }>();
  readonly saves: { scope: string; files: string[] }[] = [];
  loads: string[] = [];
  private n = 0;
  failLoad: string | null = null;
  quota = Infinity;

  async load(scope: string): Promise<LoadedSnapshot> {
    this.loads.push(scope);
    if (scope === this.failLoad) throw new Error('disk on fire');
    const s = this.scopes.get(scope);
    return s ? { files: s.snapshot.files, etag: s.etag } : { files: [], etag: null };
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    const bytes = snapshot.files.reduce((n, f) => n + f.bytes.length, 0);
    if (bytes > this.quota) throw new ScopeQuotaError(scope, bytes, this.quota);
    const cur = this.scopes.get(scope);
    if ((cur?.etag ?? null) !== etag) return { conflict: { files: cur?.snapshot.files ?? [], etag: cur?.etag ?? '' } };
    const next = { snapshot: { files: snapshot.files.map((f) => ({ ...f, bytes: f.bytes.slice() })) }, etag: `e${++this.n}` };
    this.scopes.set(scope, next);
    this.saves.push({ scope, files: snapshot.files.map((f) => `${f.path}=${dec.decode(f.bytes)}`) });
    return { etag: next.etag };
  }

  /** Another device or tab stores the scope. */
  put(scope: string, files: [string, number, string][]): void {
    this.scopes.set(scope, { snapshot: { files: files.map(([path, mtime, text]) => ({ path, mtime, bytes: enc.encode(text) })) }, etag: `x${++this.n}` });
  }

  text(scope: string): string[] {
    return (this.scopes.get(scope)?.snapshot.files ?? []).map((f) => `${f.path}=${dec.decode(f.bytes)}`);
  }
}

interface Setup {
  readonly vfs: Vfs;
  readonly sync: ScopeSync;
  readonly lines: string[];
  readonly unsaved: boolean[];
  readonly clock: { t: number };
}

async function setup(store: BdjStore, opts: { quotaBytes?: number; scopes?: StoreScope[]; memLimitBytes?: number } = {}): Promise<Setup> {
  const lines: string[] = [];
  const unsaved: boolean[] = [];
  const clock = { t: 1_700_000_000_000 };
  const sync = await ScopeSync.load(opts.scopes ?? [PERSISTENT, BUDA], {
    store,
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    log: (l) => lines.push(l),
    onUnsaved: (u) => unsaved.push(u),
    ...(opts.quotaBytes !== undefined ? { quotaBytes: opts.quotaBytes } : {}),
  });
  let s: ScopeSync | null = null;
  const vfs = new Vfs({
    disc: null,
    jdkLib: rtBdj,
    nowMs: () => clock.t,
    onChange: (p, c, to) => s?.changed(p, c, to),
    onFull: (p) => s?.refused(p),
    ...(opts.memLimitBytes !== undefined ? { memLimitBytes: opts.memLimitBytes } : {}),
  });
  sync.attach(vfs);
  s = sync;
  return { vfs, sync, lines, unsaved, clock };
}

function write(vfs: Vfs, path: string, text: string): boolean {
  const parts = path.split('/');
  for (let i = 2; i < parts.length; i++) vfs.mkdir(parts.slice(0, i).join('/'));
  const h = vfs.open(path, 'w')!;
  const b = enc.encode(text);
  const ok = vfs.write(h, b, 0, b.length);
  vfs.close(h);
  return ok;
}

function read(vfs: Vfs, path: string): string {
  const h = vfs.open(path, 'r');
  if (!h) return '<missing>';
  const out = new Uint8Array(h.size());
  vfs.read(h, out, 0, out.length);
  return dec.decode(out);
}

describe('ScopeSync', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('puts what the store keeps into the VFS before Java runs, with its mtimes', async () => {
    const store = new MemoryStore();
    store.put(PERSISTENT.key, [['4001/settings', 1_600_000_000_000, 'volume=7']]);
    const { vfs } = await setup(store);
    expect(store.loads).toEqual([PERSISTENT.key, BUDA.key]);
    expect(read(vfs, '/persistent/7fff0123/4001/settings')).toBe('volume=7');
    expect(vfs.stat('/persistent/7fff0123/4001/settings')?.mtimeMs).toBe(1_600_000_000_000);
    expect(vfs.stat(BUDA.dir)).toBeNull(); // an empty scope makes nothing (BDJAppProxy.createStorage does)
  });

  it('saves a written scope 2 s after its last write, once, and only the scopes written', async () => {
    const store = new MemoryStore();
    const { vfs, unsaved } = await setup(store);
    write(vfs, '/persistent/7fff0123/4001/a', '1');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 500);
    write(vfs, '/persistent/7fff0123/4001/a', '2');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(store.saves).toEqual([]);
    expect(unsaved).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.saves).toEqual([{ scope: PERSISTENT.key, files: ['4001/a=2'] }]);
    expect(unsaved).toEqual([true, false]);
    // a directory made changes nothing stored: no save
    vfs.mkdir('/persistent/7fff0123/4002');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(store.saves.length).toBe(1);
  });

  it('saves at once on flush (a stop, pagehide) without waiting for the debounce', async () => {
    const store = new MemoryStore();
    const { vfs, sync } = await setup(store);
    write(vfs, `${BUDA.dir}/resume`, '00:42');
    await sync.flush();
    expect(store.text(BUDA.key)).toEqual(['resume=00:42']);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(store.saves.length).toBe(1);
  });

  it('a write past the quota is refused, and the stored snapshot keeps the file as last complete (Review Focus 2)', async () => {
    const store = new MemoryStore();
    store.put(PERSISTENT.key, [['4001/save', 1000, 'old']]);
    const { vfs, sync, lines } = await setup(store, { quotaBytes: 10 });
    write(vfs, '/persistent/7fff0123/4001/other', 'abc');
    // the save is rewritten in pieces and runs out of room in the middle
    const h = vfs.open('/persistent/7fff0123/4001/save', 'w')!;
    expect(vfs.write(h, enc.encode('12345'), 0, 5)).toBe(true);
    expect(vfs.fits(h, 5)).toBe(false);
    expect(vfs.write(h, enc.encode('67890'), 0, 5)).toBe(false);
    vfs.close(h);
    expect(read(vfs, '/persistent/7fff0123/4001/save')).toBe('12345'); // Java sees what a full disk leaves
    await sync.flush();
    expect(store.text(PERSISTENT.key)).toEqual(['4001/other=abc', '4001/save=old']);
    expect(lines).toEqual(['BD-J storage: saved persistent/7fff0123 (2 files, 6 bytes)']);
    // written whole again later (after room was made), it is saved
    vfs.delete('/persistent/7fff0123/4001/other');
    expect(write(vfs, '/persistent/7fff0123/4001/save', 'new')).toBe(true);
    await sync.flush();
    expect(store.text(PERSISTENT.key)).toEqual(['4001/save=new']);
  });

  it('a file never stored that ran out of room is left out of the save', async () => {
    const store = new MemoryStore();
    const { vfs, sync } = await setup(store, { quotaBytes: 4 });
    expect(write(vfs, '/persistent/7fff0123/4001/big', '123456')).toBe(false);
    write(vfs, '/persistent/7fff0123/4001/ok', '1');
    await sync.flush();
    expect(store.text(PERSISTENT.key)).toEqual(['4001/ok=1']);
  });

  it('a save the store refuses for its quota leaves the stored snapshot and is logged', async () => {
    const store = new MemoryStore();
    store.put(PERSISTENT.key, [['a', 1000, 'kept']]);
    store.quota = 5;
    const { vfs, sync, lines } = await setup(store);
    write(vfs, '/persistent/7fff0123/a', 'too long');
    await sync.flush();
    expect(store.text(PERSISTENT.key)).toEqual(['a=kept']);
    expect(lines).toEqual([expect.stringMatching(/^BD-J storage: persistent\/7fff0123 was not saved: .*No space left on device.*the saved copy stays as it was$/)]);
  });

  it('merges a scope stored meanwhile elsewhere per file, newer mtime in seconds winning and ties ours, and Java sees the merge', async () => {
    const store = new MemoryStore();
    const { vfs, sync, clock } = await setup(store);
    clock.t = 10_000_400;
    write(vfs, '/persistent/7fff0123/mine', 'local');
    write(vfs, '/persistent/7fff0123/tie', 'local');
    write(vfs, '/persistent/7fff0123/older', 'local');
    store.put(PERSISTENT.key, [['theirs', 5000, 'remote'], ['tie', 10_000_900, 'remote'], ['older', 11_000_000, 'remote']]);
    await sync.flush();
    expect(store.text(PERSISTENT.key)).toEqual(['mine=local', 'older=remote', 'theirs=remote', 'tie=local']);
    expect(read(vfs, '/persistent/7fff0123/theirs')).toBe('remote');
    expect(read(vfs, '/persistent/7fff0123/older')).toBe('remote');
    // the next save goes on from the merged version
    write(vfs, '/persistent/7fff0123/mine', 'again');
    await sync.flush();
    expect(store.text(PERSISTENT.key)).toEqual(['mine=again', 'older=remote', 'theirs=remote', 'tie=local']);
  });

  it('a scope that does not load stays in memory only, so what the store holds is never replaced by less', async () => {
    const store = new MemoryStore();
    store.put(BUDA.key, [['x', 1000, 'precious']]);
    store.failLoad = BUDA.key;
    const { vfs, sync, lines, unsaved } = await setup(store);
    write(vfs, `${BUDA.dir}/y`, 'new');
    write(vfs, '/persistent/7fff0123/z', 'ok');
    await sync.flush();
    expect(store.text(BUDA.key)).toEqual(['x=precious']);
    expect(store.text(PERSISTENT.key)).toEqual(['z=ok']);
    expect(lines).toEqual([
      `BD-J storage: ${BUDA.key} could not be loaded (disk on fire); what is written there lasts until BD-J stops`,
      'BD-J storage: saved persistent/7fff0123 (1 files, 2 bytes)',
    ]);
    expect(unsaved).toEqual([true, false]);
  });

  it('logs once a write outside the scopes, which lasts the session only', async () => {
    const store = new MemoryStore();
    const { vfs, sync, lines } = await setup(store);
    write(vfs, '/persistent/stray.txt', '1');
    write(vfs, '/buda/1234/x', '1');
    write(vfs, '/tmp/x', '1');
    await sync.flush();
    expect(store.saves).toEqual([]);
    expect(lines).toEqual(["BD-J storage: /persistent/stray.txt is outside the disc's storage scopes; it lasts until BD-J stops"]);
  });

  describe('the organisation-level BUDA files (ruling R14)', () => {
    const ORG: StoreScope = { key: 'buda/7fff0123', dir: '/buda/7fff0123', looseOnly: true };
    const ALL = [PERSISTENT, BUDA, ORG];

    it('keeps the files beside the disc folders in buda/<orgId>, apart from the disc scope and other folders', async () => {
      const store = new MemoryStore();
      const { vfs, sync, lines } = await setup(store, { scopes: ALL });
      write(vfs, '/buda/7fff0123/38906394.log', 'log');
      write(vfs, `${BUDA.dir}/resume`, 'disc');
      write(vfs, '/buda/7fff0123/other-disc/x', 'other');
      await sync.flush();
      expect(store.text(ORG.key)).toEqual(['38906394.log=log']);
      expect(store.text(BUDA.key)).toEqual(['resume=disc']);
      expect(lines.filter((l) => l.includes('outside'))).toEqual(["BD-J storage: /buda/7fff0123/other-disc/x is outside the disc's storage scopes; it lasts until BD-J stops"]);
    });

    it('counts each file toward one scope only', async () => {
      const store = new MemoryStore();
      const { vfs } = await setup(store, { scopes: ALL, quotaBytes: 10 });
      write(vfs, '/buda/7fff0123/a.log', '123456');
      write(vfs, `${BUDA.dir}/b`, '1234567');
      write(vfs, '/buda/7fff0123/other-disc/c', '12345678901');
      expect(vfs.quotaUsed(ORG.dir)).toBe(6);
      expect(vfs.quotaUsed(BUDA.dir)).toBe(7);
      // each scope has its own 10 bytes: a loose file past the org's is refused while the disc scope has room
      expect(write(vfs, '/buda/7fff0123/d.log', '12345')).toBe(false);
      expect(write(vfs, `${BUDA.dir}/e`, '123')).toBe(true);
    });

    it('loads only loose files into it, whatever a stored snapshot holds', async () => {
      const store = new MemoryStore();
      store.put(ORG.key, [['x.log', 1000, 'kept'], [`${BUDA.dir.split('/').pop()}/resume`, 1000, 'not here']]);
      const { vfs } = await setup(store, { scopes: ALL });
      expect(read(vfs, '/buda/7fff0123/x.log')).toBe('kept');
      expect(read(vfs, `${BUDA.dir}/resume`)).toBe('<missing>');
    });

    it('lasts into the next session with IndexedDB', async () => {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const idb = new IDBFactory();
      const first = await setup(new IdbBdjStore('local', idb), { scopes: ALL });
      write(first.vfs, '/buda/7fff0123/38906394.log', 'line 1');
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      await vi.waitFor(() => expect(first.unsaved).toEqual([true, false]));
      const next = await setup(new IdbBdjStore('local', idb), { scopes: ALL });
      expect(read(next.vfs, '/buda/7fff0123/38906394.log')).toBe('line 1');
      expect(next.vfs.exportFiles(BUDA.dir)).toEqual([]);
    });
  });

  it('with IndexedDB, a save lasts into the next session, and two sources keep their own', async () => {
    // fake-indexeddb schedules with setImmediate, which stays real here
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const idb = new IDBFactory();
    const first = await setup(new IdbBdjStore('local', idb));
    write(first.vfs, '/persistent/7fff0123/4001/count', '1');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await vi.waitFor(() => expect(first.unsaved).toEqual([true, false]));
    const next = await setup(new IdbBdjStore('local', idb));
    expect(read(next.vfs, '/persistent/7fff0123/4001/count')).toBe('1');
    const nas = await setup(new IdbBdjStore('nas:abc', idb));
    expect(read(nas.vfs, '/persistent/7fff0123/4001/count')).toBe('<missing>');
  });
});
