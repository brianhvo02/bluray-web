/// <reference types="node" />
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiscHandler, findDiscs } from '../../../tools/disc-server/server';
import { DiscError } from './byte-source';
import { HttpSource } from './http-source';
import { openDisc } from './open-disc';

const TOKEN = 'http-source-test-token';
const SYNTHETIC = fileURLToPath(new URL('../../../fixtures/synthetic/', import.meta.url));

const servers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The disc server over fixtures/synthetic; returns the base URL of disc `name`. */
async function discServer(name: string): Promise<string> {
  const origin = await serve(createDiscHandler({ roots: [SYNTHETIC], token: TOKEN }));
  const disc = findDiscs([SYNTHETIC]).find((d) => d.name === name);
  if (!disc) throw new Error(`no synthetic disc ${name}`);
  return `${origin}/discs/${disc.id}`;
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('HttpSource', () => {
  it('opens the synthetic disc over HTTP, and openDisc succeeds on it', async () => {
    const source = await HttpSource.open(await discServer('disc1'), TOKEN);
    expect(source.paths()).toContain('BDMV/INDEX.BDMV');
    expect(source.exists('bdmv/index.bdmv')).toBe(true);
    expect(source.list('BDMV/STREAM')).toEqual(['00001.M2TS', '00002.M2TS']);
    const disc = await openDisc(source);
    expect(disc.summaries.length).toBeGreaterThan(0);
  });

  it('reads byte ranges and clamps at the end of the file, like FileSource', async () => {
    const source = await HttpSource.open(await discServer('disc1'), TOKEN);
    const size = source.size('BDMV/INDEX.BDMV');
    const head = await source.read('BDMV/index.bdmv', 0, 4);
    expect(new TextDecoder().decode(head)).toBe('INDX');
    expect((await source.read('BDMV/INDEX.BDMV', size - 2, 100)).length).toBe(2);
    expect((await source.read('BDMV/INDEX.BDMV', size + 5, 4)).length).toBe(0);
    await expect(source.read('BDMV/MovieObject.bdmv', 0, 1)).rejects.toMatchObject({ code: 'missing-file' });
  });

  it('maps a refused manifest (wrong token) to read-failed', async () => {
    const base = await discServer('disc1');
    const err = await HttpSource.open(base, 'wrong').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscError);
    expect((err as DiscError).code).toBe('read-failed');
  });

  it('maps an unreachable server to read-failed', async () => {
    const origin = await serve((_req, res) => res.end());
    servers.pop()!.close();
    await expect(HttpSource.open(`${origin}/discs/x`, TOKEN)).rejects.toMatchObject({ code: 'read-failed' });
  });

  it('maps HTTP errors and short bodies on a read to read-failed', async () => {
    const origin = await serve((req, res) => {
      if (req.url?.endsWith('/manifest')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ files: [{ path: 'BDMV/index.bdmv', size: 100 }, { path: 'BDMV/STREAM/00001.m2ts', size: 100 }] }));
      } else if (req.url?.includes('index.bdmv')) {
        res.statusCode = 500;
        res.end();
      } else {
        res.statusCode = 206; // claims the range but sends less
        res.setHeader('content-range', 'bytes 0-49/100');
        res.end(Buffer.alloc(10));
      }
    });
    const source = await HttpSource.open(`${origin}/discs/x`, TOKEN);
    await expect(source.read('BDMV/index.bdmv', 0, 10)).rejects.toMatchObject({ code: 'read-failed' });
    await expect(source.read('BDMV/STREAM/00001.m2ts', 0, 50)).rejects.toMatchObject({ code: 'read-failed' });
  });

  it('refuses a manifest with files whose names differ only in case', async () => {
    const origin = await serve((_req, res) => {
      res.end(JSON.stringify({ files: [{ path: 'BDMV/index.bdmv', size: 1 }, { path: 'BDMV/INDEX.BDMV', size: 1 }] }));
    });
    await expect(HttpSource.open(`${origin}/discs/x`, TOKEN)).rejects.toMatchObject({ code: 'case-collision' });
  });

  it('sends the token and the range', async () => {
    const seen: Array<{ url?: string; auth?: string; range?: string }> = [];
    const origin = await serve((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, range: req.headers.range });
      if (req.url?.endsWith('/manifest')) res.end(JSON.stringify({ files: [{ path: 'BDMV/STREAM/My Clip#1.m2ts', size: 6_000_000_000 }] }));
      else {
        res.statusCode = 206;
        res.end(Buffer.alloc(4));
      }
    });
    const source = await HttpSource.open(`${origin}/discs/abc/`, TOKEN);
    await source.read('BDMV/STREAM/MY CLIP#1.M2TS', 5_000_000_000, 4);
    expect(seen[1]).toEqual({ url: '/discs/abc/file/BDMV/STREAM/My%20Clip%231.m2ts', auth: `Bearer ${TOKEN}`, range: 'bytes=5000000000-5000000003' });
  });

  it('cancels an in-flight read when its signal aborts', async () => {
    let requested!: () => void;
    const arrived = new Promise<void>((resolve) => (requested = resolve));
    const origin = await serve((req, res) => {
      if (req.url?.endsWith('/manifest')) {
        res.end(JSON.stringify({ files: [{ path: 'BDMV/STREAM/00001.m2ts', size: 1_000_000 }] }));
        return;
      }
      res.writeHead(206, { 'content-length': '1000' });
      res.write(Buffer.alloc(10)); // then stalls: only the abort can end the read
      requested();
    });
    const source = await HttpSource.open(`${origin}/discs/x`, TOKEN);
    const controller = new AbortController();
    const reading = source.read('BDMV/STREAM/00001.m2ts', 0, 1000, controller.signal);
    await arrived;
    const reason = new Error('seek');
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const source = await HttpSource.open(await discServer('disc1'), TOKEN);
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(source.read('BDMV/INDEX.BDMV', 0, 4, controller.signal)).rejects.toThrow('gone');
  });
});
