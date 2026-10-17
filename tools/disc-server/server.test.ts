import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { request, createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiscHandler, findDiscs, isLocalAddress, parseRange } from './server';

const TOKEN = 'test-token-0123456789';
const GIB = 1024 ** 3;
const BIG_SIZE = 5 * GIB; // over 4 GiB: sizes and offsets beyond 2^32
const MARK_AT = 4.5 * GIB;
const MARK = Buffer.from('far-marker');

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

let dir: string;
let distDir: string;
let server: Server;
let port: number;
/** The remote address the handler sees; tests set it to check the LAN filter. */
let remote = '127.0.0.1';

/** A raw request: the path goes out unnormalised (`..` survives), unlike fetch. */
function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

async function discId(name: string): Promise<string> {
  const list = JSON.parse((await get('/discs', auth)).body.toString()) as Array<{ id: string; name: string }>;
  const found = list.find((d) => d.name === name);
  if (!found) throw new Error(`no disc ${name} in ${JSON.stringify(list)}`);
  return found.id;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'disc-server-'));
  const disc = join(dir, 'library', 'Big Disc');
  mkdirSync(join(disc, 'BDMV', 'STREAM'), { recursive: true });
  writeFileSync(join(disc, 'BDMV', 'index.bdmv'), Buffer.from('INDX0200abcdefghij'));
  // sparse: only the marker's block is ever written, so the test needs no 5 GiB of disk or memory
  const fd = openSync(join(disc, 'BDMV', 'STREAM', '00000.m2ts'), 'w');
  writeSync(fd, MARK, 0, MARK.length, MARK_AT);
  writeSync(fd, Buffer.from([0x47]), 0, 1, BIG_SIZE - 1);
  closeSync(fd);
  writeFileSync(join(dir, 'library', 'secret.txt'), 'not part of any disc');
  mkdirSync(join(dir, 'library', 'Not A Disc'));
  distDir = join(dir, 'dist');
  mkdirSync(distDir);
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>player</title>');

  const handler = createDiscHandler({ roots: [join(dir, 'library')], token: TOKEN, distDir, remoteAddressOf: () => remote });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('isLocalAddress', () => {
  it('accepts loopback and private LAN addresses only', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '::ffff:192.168.1.20', '169.254.3.4', 'fe80::1', 'fd12:3456::1']) {
      expect(isLocalAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '::ffff:8.8.8.8', '2001:db8::1', '', 'nonsense']) {
      expect(isLocalAddress(a), a).toBe(false);
    }
  });
});

describe('parseRange', () => {
  it('parses single byte ranges against the size', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=95-200', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange(`bytes=${MARK_AT}-${MARK_AT + 9}`, BIG_SIZE)).toEqual({ start: MARK_AT, end: MARK_AT + 9 });
  });

  it('reports unsatisfiable ranges and ignores ones it does not understand', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=9-2', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('findDiscs', () => {
  it('finds the folders that contain BDMV/index.bdmv, with stable ids', () => {
    const a = findDiscs([join(dir, 'library')]);
    const b = findDiscs([join(dir, 'library')]);
    expect(a.map((d) => d.name)).toEqual(['Big Disc']);
    expect(a[0]!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(b[0]!.id).toBe(a[0]!.id);
  });
});

describe('disc server', () => {
  it('refuses API requests without the token (401)', async () => {
    expect((await get('/discs')).status).toBe(401);
    expect((await get('/discs', { authorization: 'Bearer wrong' })).status).toBe(401);
    const id = await discId('Big Disc');
    expect((await get(`/discs/${id}/manifest`)).status).toBe(401);
    expect((await get(`/discs/${id}/file/BDMV/index.bdmv`)).status).toBe(401);
  });

  it('accepts the token as ?token= too', async () => {
    const r = await get(`/discs?token=${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('refuses every request from an address outside the local network (403)', async () => {
    remote = '8.8.8.8';
    try {
      expect((await get('/discs', auth)).status).toBe(403);
      expect((await get('/')).status).toBe(403);
    } finally {
      remote = '127.0.0.1';
    }
    remote = '::ffff:192.168.1.30';
    try {
      expect((await get('/discs', auth)).status).toBe(200);
    } finally {
      remote = '127.0.0.1';
    }
  });

  it('lists discs and serves a manifest of root-relative paths and sizes', async () => {
    const id = await discId('Big Disc');
    const r = await get(`/discs/${id}/manifest`, auth);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    const manifest = JSON.parse(r.body.toString()) as { files: Array<{ path: string; size: number }> };
    expect(manifest.files).toEqual([
      { path: 'BDMV/STREAM/00000.m2ts', size: BIG_SIZE },
      { path: 'BDMV/index.bdmv', size: 18 },
    ]);
    expect((await get('/discs/0000000000000000/manifest', auth)).status).toBe(404);
  });

  it('refuses paths that climb out of the disc (400)', async () => {
    const id = await discId('Big Disc');
    for (const p of ['../secret.txt', 'BDMV/../../secret.txt', '%2e%2e/secret.txt', 'BDMV/%2e%2e/%2e%2e/secret.txt', '..%2fsecret.txt', 'BDMV//index.bdmv', './BDMV/index.bdmv', 'BDMV%5c..%5c..%5csecret.txt', 'BDMV/index.bdmv%00']) {
      const r = await get(`/discs/${id}/file/${p}`, auth);
      expect(r.status, p).toBe(400);
    }
    expect((await get(`/discs/${id}/../../secret.txt`, auth)).status).toBe(400);
    expect((await get(`/discs/${id}/file/BDMV/MovieObject.bdmv`, auth)).status).toBe(404);
    expect((await get(`/discs/${id}/file/BDMV/STREAM`, auth)).status).toBe(404); // a directory
  });

  it('answers Range: bytes=0-9 with 206 and 10 bytes', async () => {
    const id = await discId('Big Disc');
    const r = await get(`/discs/${id}/file/BDMV/index.bdmv`, { ...auth, range: 'bytes=0-9' });
    expect(r.status).toBe(206);
    expect(r.body.toString()).toBe('INDX0200ab');
    expect(r.headers['content-range']).toBe('bytes 0-9/18');
    expect(r.headers['content-length']).toBe('10');
    expect(r.headers['accept-ranges']).toBe('bytes');
  });

  it('answers a whole-file GET with 200, and HEAD with headers only', async () => {
    const id = await discId('Big Disc');
    const r = await get(`/discs/${id}/file/BDMV/index.bdmv`, auth);
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('INDX0200abcdefghij');
    const h = await get(`/discs/${id}/file/BDMV/STREAM/00000.m2ts`, auth, 'HEAD');
    expect(h.status).toBe(200);
    expect(h.headers['content-length']).toBe(String(BIG_SIZE));
    expect(h.body.length).toBe(0);
  });

  it('answers a range starting beyond the end of the file with 416', async () => {
    const id = await discId('Big Disc');
    const r = await get(`/discs/${id}/file/BDMV/index.bdmv`, { ...auth, range: 'bytes=18-30' });
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */18');
  });

  it('serves ranges of a file over 4 GiB without reading the rest of it', async () => {
    const id = await discId('Big Disc');
    const r = await get(`/discs/${id}/file/BDMV/STREAM/00000.m2ts`, { ...auth, range: `bytes=${MARK_AT}-${MARK_AT + MARK.length - 1}` });
    expect(r.status).toBe(206);
    expect(r.body.equals(MARK)).toBe(true);
    expect(r.headers['content-range']).toBe(`bytes ${MARK_AT}-${MARK_AT + MARK.length - 1}/${BIG_SIZE}`);
    const tail = await get(`/discs/${id}/file/BDMV/STREAM/00000.m2ts`, { ...auth, range: 'bytes=-1' });
    expect([...tail.body]).toEqual([0x47]);
  });

  it('serves the built player without a token, cross-origin isolated', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toContain('<title>player</title>');
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(r.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect((await get('/missing.js')).status).toBe(404);
    expect((await get('/../secret.txt')).status).toBe(400);
  });

  it('answers a CORS preflight without the token, and only for the API', async () => {
    const id = await discId('Big Disc');
    const r = await get(`/discs/${id}/file/BDMV/index.bdmv`, { origin: 'http://localhost:5173', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,range' }, 'OPTIONS');
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(r.headers['access-control-allow-headers']).toMatch(/authorization/i);
    const g = await get(`/discs/${id}/file/BDMV/index.bdmv`, { ...auth, origin: 'http://localhost:5173', range: 'bytes=0-0' });
    expect(g.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(g.headers['access-control-expose-headers']).toMatch(/content-range/i);
  });
});
