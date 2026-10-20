import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDiscHandler, discApiBase, findDiscs } from '../../../tools/disc-server/server';
import { BDJ_REMOTE_CHUNK_BYTES, BDJ_REMOTE_IN_FLIGHT } from '../disc/disc-spec';
import type { DiscManifest } from '../disc/nas-api';
import { fakeNas } from '../../../tests/helpers/fake-nas';
import { fixtureDiscFiles } from '../../../tests/helpers/fixture-disc';
import { discEntries, syntheticSource } from '../../../tests/helpers/synthetic-disc';
import type { BdjStore, LoadedSnapshot, SaveResult, Snapshot } from './store/bdj-store';
import { discScopes } from './store/scopes';
import { StartupWatch, runBdjWorker, type BdjPort } from './bdj-worker';
import { createGraphicsPlane } from './graphics-plane';
import { createRegisterBuffer } from './shared-registers';
import { createStatusBlock } from './status-block';
import type { FromBdj, ToBdj } from './worker-protocol';

const jar = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../bdj-classlib/${name}`, import.meta.url))));

describe('StartupWatch (the start-up deadlock dump)', () => {
  it('dumps the first deadlock only while Java has shown nothing: no playlist, visible plane or still (ruling R7)', () => {
    const idle = new StartupWatch();
    idle.call('selectPlaylist', [-1, -1, -1, '-1']); // a close selects nothing
    idle.still(null); // nor does a cleared still
    idle.plane(false);
    expect(idle.deadlock()).toBe(true);
    expect(idle.deadlock()).toBe(false); // once

    for (const show of [
      (w: StartupWatch) => w.call('selectPlaylist', [5, -1, -1, '-1']),
      (w: StartupWatch) => w.plane(true), // a still menu waiting for keys
      (w: StartupWatch) => w.still(new Uint8Array([1])),
    ]) {
      const w = new StartupWatch();
      show(w);
      w.plane(false); // a menu taken down later still showed Java runs
      expect(w.deadlock()).toBe(false);
    }
  });
});

describe('runBdjWorker', () => {
  it("gives Java the wall clock: System.currentTimeMillis is the epoch time, as libbluray's JVM has it", async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const handle = runBdjWorker(port);
    const boot: ToBdj = {
      type: 'boot',
      registers: createRegisterBuffer(),
      status: createStatusBlock(),
      plane: createGraphicsPlane(),
      disc: { kind: 'files', entries: discEntries(fixtureDiscFiles('disc-bdj')) },
      readAheadBytes: 0,
      discId: null,
      classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
    };
    port.onmessage!({ data: boot });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    // a signed disc jar's certificates are checked against this clock (JarVerifier); 1970 sends them down another path
    const now = handle.runtime!.jvm.opts.nowMs();
    expect(Math.abs(now - Date.now())).toBeLessThan(5_000);
  }, 90_000);

  it('logs a thread dump when the engine asks (its start-up timeout), then answers dumped', async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const handle = runBdjWorker(port);
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: { kind: 'files', entries: discEntries(fixtureDiscFiles('disc-bdj')) },
        readAheadBytes: 0,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    port.onmessage!({ data: { type: 'dump', reason: 'start-up timeout' } });
    const [log, done] = received.slice(-2);
    expect(done).toEqual({ type: 'dumped' });
    const lines = log?.type === 'log' ? log.line.split('\n') : [];
    expect(lines[0]).toBe("BD-J thread dump (start-up timeout): booted, idle, 0 messages waiting for the boot, no call waiting for the engine, 0 deadlock outcomes");
    expect(lines[1]).toMatch(/^threads: \d+ live, /);
    expect(lines).toContainEqual(expect.stringMatching(/^#\d+ "Reference Handler" waiting on java\.lang\.ref\.Reference\$Lock@[0-9a-f]+$/));
    expect(lines).toContain('    at java.lang.ref.Reference.tryHandlePending(Reference.java:191)');
    expect(lines.at(-1)).toBe('events: 0 queued');
    handle.runtime!.jvm.threads.halt();
  }, 90_000);

  it('reports its memory after boot when asked (memoryStatsMs, telemetry runs), until the JVM halts', async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const handle = runBdjWorker(port);
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: { kind: 'files', entries: discEntries(fixtureDiscFiles('disc-bdj')) },
        readAheadBytes: 0,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
        memory: { classBytes: Infinity, vfsBytes: 64 * 1024 * 1024 },
        memoryStatsMs: 5000,
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('memory'), { timeout: 60_000 });
    const m = received.find((r) => r.type === 'memory');
    expect(received.map((r) => r.type).indexOf('booted')).toBeLessThan(received.indexOf(m!));
    expect(m).toMatchObject({ type: 'memory', freeType: null, jvm: { classes: expect.any(Number), classFileBytes: expect.any(Number) } });
    expect(m!.type === 'memory' && m!.jvm.classes).toBeGreaterThan(500);
    handle.runtime!.jvm.threads.halt(); // ends the reports
  }, 90_000);

  it('reads a disc on the dev disc server itself (a remote DiscSpec, as for a NAS disc), as the engine worker does', async () => {
    const root = fileURLToPath(new URL('../../../fixtures/synthetic/', import.meta.url));
    const paths: string[] = [];
    const handler = createDiscHandler({ roots: [root], token: 't' });
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const id = findDiscs([root]).find((d) => d.name === 'disc-bdj')!.id;
      const base = discApiBase(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, id);
      const manifest = (await (await fetch(`${base}manifest`, { headers: { Authorization: 'Bearer t' } })).json()) as DiscManifest;
      const received: FromBdj[] = [];
      // the engine's part: every call Java makes is answered (0, success), so First Play goes on to select its playlist
      const port: BdjPort = {
        onmessage: null,
        postMessage: (m) => {
          received.push(m);
          if (m.type === 'call') setTimeout(() => port.onmessage!({ data: { type: 'reply', id: m.id, value: 0 } }), 0);
        },
      };
      runBdjWorker(port);
      port.onmessage!({
        data: {
          type: 'boot',
          registers: createRegisterBuffer(),
          status: createStatusBlock(),
          plane: createGraphicsPlane(),
          disc: { kind: 'remote', base, token: 't', manifest },
          readAheadBytes: 16 * 1024 * 1024,
          discId: null,
          classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
        },
      });
      await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
      // First Play: the xlet's JAR is read and its Java calls the engine (selectPlaylist)
      port.onmessage!({ data: { type: 'start', title: 0xffff } });
      await vi.waitFor(() => expect(received.some((m) => m.type === 'call' && m.name === 'selectPlaylist')).toBe(true), { timeout: 60_000 });
      expect(received.some((m) => m.type === 'failed')).toBe(false);
      // the metadata came inlined in the manifest; the worker read the disc's JAR through the files route
      expect(paths).toContain(`/api/discs/${id}/manifest`);
      expect(paths.some((p) => p.startsWith(`/api/discs/${id}/files/BDMV/JAR/00000.JAR?t=t`))).toBe(true);
      expect(paths.some((p) => /INDEX\.BDMV/i.test(p) && p.includes('/files/'))).toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 90_000);

  it("reads a NAS disc with the BD-J worker's own read-ahead: 512 KiB requests, at most 2 at once (ruling R20)", async () => {
    const nas = fakeNas(fixtureDiscFiles('disc-bdj'));
    const ranges: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? '');
      if (m) ranges.push(Number(m[2]) - Number(m[1]) + 1);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        return await nas.fetch(input, init);
      } finally {
        inFlight--;
      }
    }) as typeof globalThis.fetch;
    const received: FromBdj[] = [];
    const port: BdjPort = {
      onmessage: null,
      postMessage: (m) => {
        received.push(m);
        if (m.type === 'call') setTimeout(() => port.onmessage!({ data: { type: 'reply', id: m.id, value: 0 } }), 0);
      },
    };
    runBdjWorker(port, { fetch });
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: nas.spec,
        readAheadBytes: 1024 * 1024,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    port.onmessage!({ data: { type: 'start', title: 0xffff } });
    await vi.waitFor(() => expect(received.some((m) => m.type === 'call' && m.name === 'selectPlaylist')).toBe(true), { timeout: 60_000 });
    expect(received.some((m) => m.type === 'failed')).toBe(false);
    expect(nas.requested).toContain('BDMV/JAR/00000.JAR');
    expect(ranges.length).toBeGreaterThan(0);
    expect(Math.max(...ranges)).toBeLessThanOrEqual(BDJ_REMOTE_CHUNK_BYTES);
    expect(maxInFlight).toBeLessThanOrEqual(BDJ_REMOTE_IN_FLIGHT);
  }, 90_000);
});

describe('runBdjWorker and the storage scopes', () => {
  class GatedStore implements BdjStore {
    readonly loads: string[] = [];
    readonly saved = new Map<string, Snapshot>();
    private release!: () => void;
    readonly gate = new Promise<void>((resolve) => (this.release = resolve));
    open(): void {
      this.release();
    }
    async load(scope: string): Promise<LoadedSnapshot> {
      this.loads.push(scope);
      await this.gate;
      return scope.startsWith('persistent/') ? { files: [{ path: '1/count', mtime: 1000, bytes: new Uint8Array([7]) }], etag: 'e1' } : { files: [], etag: null };
    }
    async save(scope: string, snapshot: Snapshot): Promise<SaveResult> {
      this.saved.set(scope, snapshot);
      return { etag: `e${this.saved.size + 1}` };
    }
  }

  it('boots Libbluray only once its scopes are loaded, and saves what Java wrote before it answers a stop', async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const store = new GatedStore();
    const sources: string[] = [];
    const handle = runBdjWorker(port, { createStore: (source) => (sources.push(source), store) });
    const files = fixtureDiscFiles('disc-bdj');
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: { kind: 'files', entries: discEntries(files) },
        readAheadBytes: 0,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    const scopes = await discScopes(syntheticSource(files), null);
    expect(scopes.map((s) => s.key)).toEqual([expect.stringMatching(/^persistent\/[0-9a-f]{8}$/), expect.stringMatching(/^buda\/[0-9a-f]{8}\/[0-9a-f]{32}$/), expect.stringMatching(/^buda\/[0-9a-f]{8}$/)]);
    await vi.waitFor(() => expect(store.loads).toEqual(scopes.map((s) => s.key)));
    expect(sources).toEqual(['local']);
    await vi.waitFor(() => expect(handle.runtime).not.toBeNull());
    await handle.runtime!.bootJdk(); // the JDK starts meanwhile
    await new Promise((r) => setTimeout(r, 50));
    expect(received.map((m) => m.type)).not.toContain('booted');
    store.open();
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    const vfs = handle.runtime!.jvm.opts.vfs!;
    const persistent = scopes[0]!.dir;
    expect(vfs.stat(`${persistent}/1/count`)?.size).toBe(1);

    // a write through the VFS (as Java's FileOutputStream makes it) is unsaved until the stop saves it
    const h = vfs.open(`${persistent}/1/count`, 'w')!;
    vfs.write(h, new Uint8Array([8]), 0, 1);
    vfs.close(h);
    // false once the scopes are loaded (the engine then always waits for a stop's save), then true at the write
    expect(received.filter((m) => m.type === 'unsaved')).toEqual([
      { type: 'unsaved', unsaved: false },
      { type: 'unsaved', unsaved: true },
    ]);
    port.onmessage!({ data: { type: 'stop' } });
    await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: 'stopped' }));
    expect([...store.saved.get(scopes[0]!.key)!.files[0]!.bytes]).toEqual([8]);
    expect(store.saved.has(scopes[1]!.key)).toBe(false);
    expect(received.filter((m) => m.type === 'unsaved').at(-1)).toEqual({ type: 'unsaved', unsaved: false });
    expect(handle.runtime!.jvm.threads.isHalted).toBe(true);
  }, 90_000);

  it("logs a save that fails at the stop, though the session has ended", async () => {
    const received: FromBdj[] = [];
    const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
    const store: BdjStore = {
      load: async () => ({ files: [], etag: null }),
      save: async () => {
        throw new Error('the disk is gone');
      },
    };
    const handle = runBdjWorker(port, { createStore: () => store });
    const files = fixtureDiscFiles('disc-bdj');
    port.onmessage!({
      data: {
        type: 'boot',
        registers: createRegisterBuffer(),
        status: createStatusBlock(),
        plane: createGraphicsPlane(),
        disc: { kind: 'files', entries: discEntries(files) },
        readAheadBytes: 0,
        discId: null,
        classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
      },
    });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    const [persistent] = await discScopes(syntheticSource(files), null);
    const vfs = handle.runtime!.jvm.opts.vfs!;
    vfs.mkdir(persistent!.dir);
    const h = vfs.open(`${persistent!.dir}/save`, 'w')!;
    vfs.write(h, new Uint8Array([1]), 0, 1);
    port.onmessage!({ data: { type: 'stop' } });
    await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: 'stopped' }));
    expect(received).toContainEqual({ type: 'log', line: `BD-J storage: ${persistent!.key} could not be saved (the disk is gone)`, error: false });
  }, 90_000);
});
