import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiscManifest } from '../../src/engine/disc/nas-api';
import { appHandlers } from './app';
import type { Auth } from './auth';
import { createServer } from './http';
import { Library } from './library';
import { buildManifest } from './manifest';
import { discRoutes } from './routes/discs';

const FIXTURES = join(import.meta.dirname, '../../fixtures/synthetic');
const PROBE_BYTES = 4_194_304;

/** Every regular file under `dir`, as [disc-relative path as on disk, size]. */
function walk(dir: string, base = dir): [string, number][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    return e.isDirectory() ? walk(abs, base) : [[relative(base, abs), statSync(abs).size] as [string, number]];
  });
}

describe('buildManifest', () => {
  for (const disc of ['disc-menu', 'disc-bdj']) {
    it(`lists every file of ${disc} and inlines the small ones byte for byte`, async () => {
      const dir = join(FIXTURES, disc);
      const manifest = await buildManifest(dir, { id: 'abc', name: disc });
      expect(manifest.discId).toBe('abc');
      expect(manifest.name).toBe(disc);
      const onDisk = walk(dir).map(([path, size]) => ({ path: path.toUpperCase(), size }));
      expect([...manifest.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual(onDisk.sort((a, b) => a.path.localeCompare(b.path)));

      const real = new Map(walk(dir).map(([path]) => [path.toUpperCase(), path]));
      const inlined = Object.keys(manifest.inline);
      expect(inlined).toContain('BDMV/INDEX.BDMV');
      const expected = [...real.keys()].filter((p) => /^BDMV\/(INDEX\.BDMV|MOVIEOBJECT\.BDMV|PLAYLIST\/.*\.MPLS|CLIPINF\/.*\.CLPI|AUXDATA\/SOUND\.BDMV|BDJO\/.*\.BDJO)$/.test(p));
      expect(inlined.sort()).toEqual(expected.sort());
      for (const path of inlined) {
        expect(Buffer.from(manifest.inline[path]!, 'base64').equals(readFileSync(join(dir, real.get(path)!))), path).toBe(true);
      }
      expect(inlined.some((p) => p.endsWith('.M2TS') || p.endsWith('.JAR'))).toBe(false);
    });
  }

  it('inlines CERTIFICATE/ID.BDMV and skips inline candidates over 1 MiB', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-'));
    try {
      cpSync(join(FIXTURES, 'disc1'), tmp, { recursive: true });
      mkdirSync(join(tmp, 'certificate'));
      writeFileSync(join(tmp, 'certificate/id.bdmv'), 'id-bytes');
      writeFileSync(join(tmp, 'BDMV/PLAYLIST/00009.mpls'), Buffer.alloc(1024 * 1024 + 1));
      const manifest = await buildManifest(tmp, { id: 'x', name: 'x' });
      expect(Buffer.from(manifest.inline['CERTIFICATE/ID.BDMV']!, 'base64').toString()).toBe('id-bytes');
      expect(manifest.inline['BDMV/PLAYLIST/00009.MPLS']).toBeUndefined();
      expect(manifest.files).toContainEqual({ path: 'BDMV/PLAYLIST/00009.MPLS', size: 1024 * 1024 + 1 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('disc routes', () => {
  const AWKWARD = '[BDMV] 鋼の錬金術師 #1 100% + extra';
  let tmp: string;
  let base: string;
  let server: http.Server;
  let library: Library;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'discs-'));
    const root = join(tmp, 'root');
    cpSync(join(FIXTURES, 'disc-menu'), join(root, 'menu'), { recursive: true });
    cpSync(join(FIXTURES, 'disc1'), join(root, AWKWARD), { recursive: true });
    cpSync(join(FIXTURES, 'disc1'), join(root, 'doomed'), { recursive: true });
    // A disc with a clip larger than the probe, and one with an empty file.
    cpSync(join(FIXTURES, 'disc1'), join(root, 'big'), { recursive: true });
    writeFileSync(join(root, 'big/BDMV/STREAM/00003.m2ts'), Buffer.alloc(PROBE_BYTES + 1000, 7));
    writeFileSync(join(root, 'big/BDMV/STREAM/empty.m2ts'), '');
    writeFileSync(join(root, 'disc.iso'), 'iso');
    library = new Library([{ name: 'drvA', dir: root }], join(tmp, 'library.json'), { scanPauseMs: 0 });
    await library.scan();
    for (const d of library.list('drvA')!.discs) ids[d.name] = d.id;
    server = createServer([discRoutes(library)]);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/discs`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  });

  const clip = (disc: string): Buffer => readFileSync(join(tmp, 'root', disc, 'BDMV/STREAM/00001.m2ts'));

  it('serves the manifest', async () => {
    const res = await fetch(`${base}/${ids.menu}/manifest`);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as DiscManifest;
    expect(manifest.discId).toBe(ids.menu);
    expect(manifest.name).toBe('menu');
    expect(manifest.files).toContainEqual({ path: 'BDMV/STREAM/00001.M2TS', size: clip('menu').length });
    expect(manifest.inline['BDMV/INDEX.BDMV']).toBeDefined();
  });

  it('answers a range with 206 and the bytes', async () => {
    const bytes = clip('menu');
    const res = await fetch(`${base}/${ids.menu}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: 'bytes=192-383' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 192-383/${bytes.length}`);
    expect(res.headers.get('content-length')).toBe('192');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(192, 384))).toBe(true);
  });

  it('clamps a range ending past EOF and serves the whole file without a range', async () => {
    const bytes = clip('menu');
    const tail = await fetch(`${base}/${ids.menu}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: `bytes=${bytes.length - 10}-${bytes.length + 500}` } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe(`bytes ${bytes.length - 10}-${bytes.length - 1}/${bytes.length}`);
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(bytes.length - 10))).toBe(true);
    const whole = await fetch(`${base}/${ids.menu}/files/bdmv/stream/00001.m2ts`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe(String(bytes.length));
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('answers 416 past EOF', async () => {
    const size = clip('menu').length;
    const res = await fetch(`${base}/${ids.menu}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: `bytes=${size}-` } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${size}`);
  });

  it('serves a zero-length file and refuses ranges on it', async () => {
    const whole = await fetch(`${base}/${ids.big}/files/BDMV/STREAM/EMPTY.M2TS`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe('0');
    expect((await whole.arrayBuffer()).byteLength).toBe(0);
    const ranged = await fetch(`${base}/${ids.big}/files/BDMV/STREAM/EMPTY.M2TS`, { headers: { Range: 'bytes=0-0' } });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('content-range')).toBe('bytes */0');
  });

  it('answers HEAD with the headers only', async () => {
    const size = clip('menu').length;
    const res = await fetch(`${base}/${ids.menu}/files/BDMV/STREAM/00001.M2TS`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(size));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('refuses path traversal and unknown files with 404', async () => {
    const raw = (path: string): Promise<number> =>
      new Promise((resolve, reject) => {
        http.get(`${base}/${ids.menu}/files/${path}`, (res) => {
          res.resume();
          resolve(res.statusCode!);
        }).on('error', reject);
      });
    expect(await raw('..%2F..%2Fetc%2Fpasswd')).toBe(404);
    expect(await raw('BDMV/../../x')).toBe(404);
    expect(await raw('BDMV%2F..%2F..%2Fdoomed%2FBDMV%2FINDEX.BDMV')).toBe(404);
    expect(await raw('BDMV/STREAM/99999.M2TS')).toBe(404);
    expect(await raw('BDMV/STREAM')).toBe(404);
    expect(await raw('%E0%A4%A')).toBe(404);
  });

  it('answers 404 disc-changed to an unknown disc and to one deleted after the scan', async () => {
    const unknown = await fetch(`${base}/0123456789abcdef/manifest`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'disc-changed' });
    rmSync(join(tmp, 'root', 'doomed'), { recursive: true });
    expect(library.disc(ids.doomed!)).not.toBeNull();
    for (const path of ['manifest', 'probe', 'files/BDMV/INDEX.BDMV']) {
      const res = await fetch(`${base}/${ids.doomed}/${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'disc-changed' });
    }
  });

  it('answers 404 disc-changed when index.bdmv changed after the scan', async () => {
    const index = join(tmp, 'root', 'big', 'BDMV', 'index.bdmv');
    writeFileSync(index, Buffer.concat([readFileSync(index), Buffer.from([0])]));
    const res = await fetch(`${base}/${ids.big}/files/BDMV/INDEX.BDMV`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'disc-changed' });
    await library.scan();
    for (const d of library.list('drvA')!.discs) ids[d.name] = d.id;
  });

  it('serves the bytes of a disc whose name has #, %, + and Japanese text', async () => {
    const manifest = (await (await fetch(`${base}/${ids[AWKWARD]}/manifest`)).json()) as DiscManifest;
    expect(manifest.name).toBe(AWKWARD);
    const res = await fetch(`${base}/${ids[AWKWARD]}/files/${encodeURIComponent('BDMV/STREAM/00001.M2TS')}`, { headers: { Range: 'bytes=0-191' } });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(clip(AWKWARD).subarray(0, 192))).toBe(true);
  });

  it('probes the first 4 MiB of the largest clip, or the whole clip when smaller', async () => {
    const big = await fetch(`${base}/${ids.big}/probe`);
    expect(big.status).toBe(200);
    expect(big.headers.get('content-length')).toBe(String(PROBE_BYTES));
    expect(big.headers.get('cache-control')).toBe('private, max-age=3600');
    const body = Buffer.from(await big.arrayBuffer());
    expect(body.length).toBe(PROBE_BYTES);
    expect(body.equals(readFileSync(join(tmp, 'root', 'big/BDMV/STREAM/00003.m2ts')).subarray(0, PROBE_BYTES))).toBe(true);

    const small = await fetch(`${base}/${ids.menu}/probe`);
    const largest = readFileSync(join(tmp, 'root', 'menu/BDMV/STREAM/00002.m2ts'));
    expect(Buffer.from(await small.arrayBuffer()).equals(largest)).toBe(true);
  });

  it('sits behind the token guard in the app', async () => {
    const auth = { verify: (token: string) => (token === 'good' ? { id: 'd' } : null) } as unknown as Auth;
    const app = createServer(appHandlers({ auth, library, publicBase: 'https://nas.example/' }));
    await new Promise<void>((r) => app.listen(0, r));
    try {
      const appBase = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/discs/${ids.menu}`;
      expect((await fetch(`${appBase}/probe`)).status).toBe(401);
      expect((await fetch(`${appBase}/files/BDMV/INDEX.BDMV?t=bad`)).status).toBe(401);
      const ok = await fetch(`${appBase}/files/BDMV/INDEX.BDMV?t=good`, { headers: { Range: 'bytes=0-3' } });
      expect(ok.status).toBe(206);
      expect(await ok.text()).toBe('INDX');
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  it('answers 501 iso-not-yet for ISO discs', async () => {
    for (const path of ['manifest', 'probe', 'files/BDMV/INDEX.BDMV']) {
      const res = await fetch(`${base}/${ids['disc.iso']}/${path}`);
      expect(res.status, path).toBe(501);
      expect(await res.json()).toEqual({ error: 'iso-not-yet' });
    }
  });
});
