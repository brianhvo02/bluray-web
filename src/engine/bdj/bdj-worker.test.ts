import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDiscHandler, discApiBase, findDiscs } from '../../../tools/disc-server/server';
import type { DiscManifest } from '../disc/nas-api';
import { fixtureDiscFiles } from '../../../tests/helpers/fixture-disc';
import { discEntries } from '../../../tests/helpers/synthetic-disc';
import { runBdjWorker, type BdjPort } from './bdj-worker';
import { createGraphicsPlane } from './graphics-plane';
import { createRegisterBuffer } from './shared-registers';
import { createStatusBlock } from './status-block';
import type { FromBdj, ToBdj } from './worker-protocol';

const jar = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../bdj-classlib/${name}`, import.meta.url))));

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
});
