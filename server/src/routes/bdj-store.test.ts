import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore, SCOPE_LIMIT_BYTES } from '../bdj-store';
import { createServer } from '../http';
import { Library } from '../library';
import { Store } from '../store';
import { EMPTY_TAR, listTar, writeTar } from '../tar';

// Every name here is made up.

const ORG = '0a1b2c3d';
const SCOPE = `persistent/${ORG}`;
const BUDA = `buda/${ORG}/${'e'.repeat(32)}`;

let tmp: string;
let base = '';
let close: (() => void) | undefined;
let auth: Auth;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'bdj-store-routes-'));
  const data = join(tmp, 'data');
  auth = new Auth(new Store(data), Date.now);
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  const server = createServer(appHandlers({ auth, library, bdjStore: new BdjStore(data), publicBase: 'https://nas.example/bluray/api/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    server.closeAllConnections();
  };
});
afterEach(() => {
  close?.();
  rmSync(tmp, { recursive: true, force: true });
});

async function tokenFor(name: string): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { code } = auth.createCode({ newPerson: { name, owner: false } });
  const device = auth.redeem(code, `${name}'s phone`, jwk)!;
  const challenge = auth.challenge(device.id)!;
  const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
  return auth.startSession(device.id, challenge, signature)!.token;
}

const tar = (text: string): Buffer => writeTar([{ path: 'saves/slot0', data: Buffer.from(text), mtime: 1_700_000_000 }]);

function call(method: string, scope: string, token: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Response> {
  return fetch(`${base}/api/bdj-store/${scope}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
}

function tempFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.tmp'));
}

describe('bdj-store routes', () => {
  it('answers an empty archive with no ETag for a scope with no snapshot', async () => {
    const token = await tokenFor('Mika');
    const res = await call('GET', SCOPE, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-tar');
    expect(res.headers.get('etag')).toBeNull();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(EMPTY_TAR);
  });

  it('round-trips a snapshot under its quoted ETag', async () => {
    const token = await tokenFor('Mika');
    const put = await call('PUT', SCOPE, token, { 'If-None-Match': '*' }, tar('level 1'));
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag');
    expect(etag).toMatch(/^"[^"]+"$/);

    const got = await call('GET', SCOPE, token);
    expect(got.headers.get('etag')).toBe(etag);
    expect(Buffer.from(await got.arrayBuffer())).toEqual(tar('level 1'));

    const next = await call('PUT', SCOPE, token, { 'If-Match': etag! }, tar('level 2'));
    expect(next.status).toBe(200);
    expect(next.headers.get('etag')).not.toBe(etag);
    expect((await call('PUT', SCOPE, token, { 'If-Match': '*' }, tar('level 3'))).status).toBe(200);

    expect((await call('DELETE', SCOPE, token, { 'If-Match': '"stale"' })).status).toBe(412);
    const current = (await call('GET', SCOPE, token)).headers.get('etag')!;
    expect((await call('DELETE', SCOPE, token, { 'If-Match': current })).status).toBe(204);
    expect((await call('GET', SCOPE, token)).headers.get('etag')).toBeNull();
  });

  it('answers 412 to a stale or missing precondition target, and 428 without one', async () => {
    const token = await tokenFor('Mika');
    expect((await call('PUT', SCOPE, token, { 'If-Match': '*' }, tar('a'))).status).toBe(412);
    expect((await call('PUT', SCOPE, token, { 'If-Match': '"nope"' }, tar('a'))).status).toBe(412);
    expect((await call('DELETE', SCOPE, token, { 'If-Match': '*' })).status).toBe(412);
    const etag = (await call('PUT', SCOPE, token, { 'If-None-Match': '*' }, tar('a'))).headers.get('etag')!;
    const again = await call('PUT', SCOPE, token, { 'If-None-Match': '*' }, tar('b'));
    expect(again.status).toBe(412);
    expect((await call('PUT', SCOPE, token, { 'If-Match': '"stale"' }, tar('b'))).status).toBe(412);

    const none = await call('PUT', SCOPE, token, {}, tar('b'));
    expect(none.status).toBe(428);
    expect((await call('DELETE', SCOPE, token)).status).toBe(428);
    expect((await call('GET', SCOPE, token)).headers.get('etag')).toBe(etag);
  });

  it('answers 400 to a bad scope or a bad archive', async () => {
    const token = await tokenFor('Mika');
    for (const scope of ['persistent/0A1B2C3D', `buda/${ORG}/`, `buda/${ORG}/x`, 'persistent/../x', '', `persistent/${ORG}/extra`, 'other/0a1b2c3d']) {
      expect((await call('GET', scope, token)).status, scope).toBe(400);
    }
    const bad = await call('PUT', SCOPE, token, { 'If-None-Match': '*' }, Buffer.alloc(700, 7));
    expect(bad.status).toBe(400);
    const link = writeTar([{ path: 'x', data: Buffer.from('x'), mtime: 1 }]);
    link[156] = '2'.charCodeAt(0); // typeflag: symlink, with the header checksum made right again
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : link[i]!;
    link.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    expect(() => listTar(link)).toThrow(/regular file/);
    expect((await call('PUT', SCOPE, token, { 'If-None-Match': '*' }, link)).status).toBe(400);
  });

  it('answers 401 without a valid token', async () => {
    expect((await fetch(`${base}/api/bdj-store/${SCOPE}`)).status).toBe(401);
    expect((await call('GET', SCOPE, 'forged.token')).status).toBe(401);
  });

  it('takes the token from t= too', async () => {
    const token = await tokenFor('Mika');
    expect((await fetch(`${base}/api/bdj-store/${SCOPE}?t=${encodeURIComponent(token)}`)).status).toBe(200);
  });

  it("keeps each person's store apart", async () => {
    const mika = await tokenFor('Mika');
    const sora = await tokenFor('Sora');
    expect((await call('PUT', BUDA, mika, { 'If-None-Match': '*' }, tar('mika'))).status).toBe(200);
    expect((await call('PUT', BUDA, sora, { 'If-None-Match': '*' }, tar('sora'))).status).toBe(200);
    const read = async (token: string): Promise<Buffer> => Buffer.from(await (await call('GET', BUDA, token)).arrayBuffer());
    expect(await read(mika)).toEqual(tar('mika'));
    expect(await read(sora)).toEqual(tar('sora'));
  });

  it('refuses a write naming another person in X-Bdj-Person with 409, writing nothing', async () => {
    const mika = await tokenFor('Mika');
    const sora = await tokenFor('Sora');
    const mikaId = auth.verify(mika)!.personId;
    const soraId = auth.verify(sora)!.personId;
    const put = await call('PUT', SCOPE, mika, { 'If-None-Match': '*', 'X-Bdj-Person': soraId }, tar('mika'));
    expect(put.status).toBe(409);
    expect(await put.json()).toEqual({ error: 'person-changed' });
    expect((await call('GET', SCOPE, mika)).headers.get('etag')).toBeNull();
    const ok = await call('PUT', SCOPE, mika, { 'If-None-Match': '*', 'X-Bdj-Person': mikaId }, tar('mika'));
    expect(ok.status).toBe(200);
    const del = await call('DELETE', SCOPE, mika, { 'If-Match': '*', 'X-Bdj-Person': soraId });
    expect(del.status).toBe(409);
    expect((await call('GET', SCOPE, mika)).headers.get('etag')).toBe(ok.headers.get('etag'));
    expect((await call('DELETE', SCOPE, mika, { 'If-Match': '*', 'X-Bdj-Person': mikaId })).status).toBe(204);
  });

  it('refuses a PUT whose device moves to another person while its body arrives', async () => {
    const mika = await tokenFor('Mika');
    const sora = await tokenFor('Sora');
    const device = auth.verify(mika)!;
    const mikaId = device.personId;
    const soraId = auth.verify(sora)!.personId;
    const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(`${base}/api/bdj-store/${SCOPE}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${mika}`, 'If-None-Match': '*', 'X-Bdj-Person': mikaId, 'Transfer-Encoding': 'chunked' },
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      const body = tar('mika');
      req.write(body.subarray(0, 512));
      setTimeout(() => {
        auth.moveDevice(device.id, soraId);
        req.end(body.subarray(512));
      }, 50);
    });
    expect(await answer).toEqual({ status: 409, body: '{"error":"person-changed"}' });
    expect((await call('GET', SCOPE, sora)).headers.get('etag')).toBeNull();
    expect((await call('GET', SCOPE, mika)).headers.get('etag')).toBeNull();
  });

  /** Sends a PUT of `parts` (then ends it unless `hang`) and answers the response, failing on a reset connection. */
  function put(token: string, parts: Buffer[], opts: { length?: number; hang?: boolean } = {}): Promise<{ status: number; body: string; ms: number }> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'If-None-Match': '*' };
      if (opts.length !== undefined) headers['Content-Length'] = String(opts.length);
      const req = request(`${base}/api/bdj-store/${SCOPE}`, { method: 'PUT', headers });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body, ms: Date.now() - started }));
      });
      req.on('error', reject);
      for (const part of parts) req.write(part);
      if (!opts.hang) req.end();
    });
  }

  const QUOTA = '{"error":"quota","limit":"scope"}';
  const BIG = (): Buffer[] => [...Array.from({ length: SCOPE_LIMIT_BYTES / (64 * 1024) }, () => Buffer.alloc(64 * 1024)), Buffer.alloc(1)];

  it('refuses a declared Content-Length over the scope limit with 507, keeping none of the body', async () => {
    const token = await tokenFor('Mika');
    const res = await put(token, BIG(), { length: SCOPE_LIMIT_BYTES + 1 });
    expect(res).toMatchObject({ status: 507, body: QUOTA });
    expect(tempFiles(tmp)).toEqual([]);
  }, 20_000);

  it('answers 507 within the drain time when an oversized upload stalls', async () => {
    const token = await tokenFor('Mika');
    const res = await put(token, [Buffer.alloc(1024)], { length: 100 * 1024 * 1024, hang: true });
    expect(res).toMatchObject({ status: 507, body: QUOTA });
    expect(res.ms).toBeLessThan(4_000);
  }, 10_000);

  it('refuses a chunked body once it passes the scope limit, with 507 and no temp file left', async () => {
    const token = await tokenFor('Mika');
    // the rest of the body is drained, so the answer arrives whole instead of a reset connection
    expect(await put(token, BIG())).toMatchObject({ status: 507, body: QUOTA });
    expect(tempFiles(tmp)).toEqual([]);
    expect((await call('GET', SCOPE, token)).headers.get('etag')).toBeNull();
  }, 20_000);

  it('answers 503 with Retry-After: 1 while another writer holds the scope', async () => {
    const token = await tokenFor('Mika');
    const person = auth.devices()[0]!.personId;
    const folder = join(tmp, 'data', 'users', person, 'bdj', 'persistent');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${ORG}.tar.lock`), '');
    const res = await call('PUT', SCOPE, token, { 'If-None-Match': '*' }, tar('a'));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
  }, 15_000);

  it('answers 405 with Allow to another method', async () => {
    const token = await tokenFor('Mika');
    for (const method of ['POST', 'PATCH']) {
      const res = await call(method, SCOPE, token);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, PUT, DELETE');
    }
  });

  it('answers 507 naming the person quota when a person is over theirs', async () => {
    close!();
    const data = join(tmp, 'data');
    const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
    const server = createServer(appHandlers({ auth, library, bdjStore: new BdjStore(data, { personLimit: 3000 }), publicBase: 'https://nas.example/bluray/api/' }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => {
      server.close();
      server.closeAllConnections();
    };
    const token = await tokenFor('Mika');
    expect((await call('PUT', SCOPE, token, { 'If-None-Match': '*' }, tar('a'))).status).toBe(200);
    const over = await call('PUT', BUDA, token, { 'If-None-Match': '*' }, tar('b'));
    expect(over.status).toBe(507);
    expect(await over.json()).toEqual({ error: 'quota', limit: 'person' });
  });
});
