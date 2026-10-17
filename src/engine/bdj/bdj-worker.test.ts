import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDiscHandler, findDiscs } from '../../../tools/disc-server/server';
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
      discFiles: discEntries(fixtureDiscFiles('disc-bdj')),
      discId: null,
      classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
    };
    port.onmessage!({ data: boot });
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
    // a signed disc jar's certificates are checked against this clock (JarVerifier); 1970 sends them down another path
    const now = handle.runtime!.jvm.opts.nowMs();
    expect(Math.abs(now - Date.now())).toBeLessThan(5_000);
  }, 90_000);

  it('opens a disc served over HTTP itself (discHttp), as the engine worker does', async () => {
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
      const received: FromBdj[] = [];
      const port: BdjPort = { onmessage: null, postMessage: (m) => void received.push(m) };
      runBdjWorker(port);
      port.onmessage!({
        data: {
          type: 'boot',
          registers: createRegisterBuffer(),
          status: createStatusBlock(),
          plane: createGraphicsPlane(),
          discFiles: [],
          discHttp: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/discs/${id}`, token: 't' },
          discId: null,
          classLibrary: { rt: jar('rt-bdj.jar'), libbluray: jar('libbluray-j2se.jar'), libblurayAwt: jar('libbluray-awt-j2se.jar') },
        },
      });
      await vi.waitFor(() => expect(received.map((m) => m.type)).toContain('booted'), { timeout: 60_000 });
      expect(received.some((m) => m.type === 'failed')).toBe(false);
      expect(paths).toContain(`/discs/${id}/manifest`);
      expect(paths.some((p) => /\/file\/BDMV\/index\.bdmv$/i.test(p))).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 90_000);
});
