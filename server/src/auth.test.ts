import type { webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHandlers } from './app';
import { Auth } from './auth';
import { ownerCode } from './cli';
import type { CodeRegistrar } from './codes';
import { createServer } from './http';
import { Library } from './library';
import { Store } from './store';

type JsonWebKey = webcrypto.JsonWebKey;

let tmp: string;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'auth-'));
  clock = 1_800_000_000_000;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const MINUTE = 60_000;

async function deviceKey(): Promise<{ jwk: JsonWebKey; sign: (text: string) => Promise<string> }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (text: string): Promise<string> => {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text));
    return Buffer.from(sig).toString('base64url');
  };
  return { jwk, sign };
}

async function session(auth: Auth, deviceId: string, sign: (text: string) => Promise<string>) {
  const challenge = auth.challenge(deviceId)!;
  return auth.startSession(deviceId, challenge, await sign(challenge));
}

describe('Auth', () => {
  it('redeems a code once', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code } = auth.createCode({ owner: false });
    const { jwk } = await deviceKey();
    expect(auth.redeem(code, 'iPad', jwk)).not.toBeNull();
    expect(auth.redeem(code, 'iPad', jwk)).toBeNull();
  });

  it('accepts the code typed loosely', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code } = auth.createCode({ owner: false });
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4, 8)} ${code.slice(8)}`;
    expect(auth.redeem(typed, 'iPad', (await deviceKey()).jwk)).not.toBeNull();
  });

  it('refuses a code 10 minutes old', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code, record } = auth.createCode({ owner: false });
    expect(record.expiresAt).toBe(clock + 10 * MINUTE);
    clock += 10 * MINUTE;
    expect(auth.redeem(code, 'iPad', (await deviceKey()).jwk)).toBeNull();
  });

  it('makes owner devices from owner codes only', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk } = await deviceKey();
    const owner = auth.redeem(auth.createCode({ owner: true }).code, 'Mac', jwk)!;
    const plain = auth.redeem(auth.createCode({ owner: false }).code, 'Phone', jwk)!;
    expect(owner.owner).toBe(true);
    expect(plain.owner).toBe(false);
    expect(owner.name).toBe('Mac');
    expect(owner.pairedAt).toBe(clock);
  });

  it('refuses a private or non-P-256 key without spending the code', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code } = auth.createCode({ owner: false });
    const priv = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']);
    expect(auth.redeem(code, 'x', await crypto.subtle.exportKey('jwk', priv.privateKey))).toBeNull();
    expect(auth.redeem(code, 'x', await crypto.subtle.exportKey('jwk', p384.publicKey))).toBeNull();
    expect(auth.redeem(code, 'x', { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'AAAA' })).toBeNull();
    expect(auth.redeem(code, 'x', (await deviceKey()).jwk)).not.toBeNull();
  });

  it('starts a session from a signed challenge', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(auth.createCode({ owner: false }).code, 'iPad', jwk)!;
    const started = await session(auth, device.id, sign);
    expect(started).not.toBeNull();
    expect(started!.expiresAt).toBe(clock + 60 * MINUTE);
    expect(auth.verify(started!.token)?.id).toBe(device.id);
  });

  it('refuses a wrong signature, a reused or stale challenge, and another device key', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const other = await deviceKey();
    const device = auth.redeem(auth.createCode({ owner: false }).code, 'iPad', jwk)!;

    const c1 = auth.challenge(device.id)!;
    expect(auth.startSession(device.id, c1, await other.sign(c1))).toBeNull();
    // A failed attempt spends the challenge.
    expect(auth.startSession(device.id, c1, await sign(c1))).toBeNull();

    const c2 = auth.challenge(device.id)!;
    expect(auth.startSession(device.id, c2, await sign(c2))).not.toBeNull();
    expect(auth.startSession(device.id, c2, await sign(c2))).toBeNull();

    const c3 = auth.challenge(device.id)!;
    clock += 60_000;
    expect(auth.startSession(device.id, c3, await sign(c3))).toBeNull();

    const c4 = auth.challenge(device.id)!;
    expect(auth.startSession(device.id, c4, 'not base64url!')).toBeNull();
    expect(auth.startSession('unknown', c4, await sign(c4))).toBeNull();
    expect(auth.challenge('unknown')).toBeNull();
  });

  it('verifies a token until it expires', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(auth.createCode({ owner: false }).code, 'iPad', jwk)!;
    const { token, expiresAt } = (await session(auth, device.id, sign))!;
    clock = expiresAt - 1;
    expect(auth.verify(token)).not.toBeNull();
    clock = expiresAt;
    expect(auth.verify(token)).toBeNull();
  });

  it('refuses forged and malformed tokens', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(auth.createCode({ owner: false }).code, 'iPad', jwk)!;
    const { token } = (await session(auth, device.id, sign))!;
    const [, mac] = token.split('.');
    const longer = Buffer.from(`${device.id}.${clock + 1e9}`).toString('base64url');
    expect(auth.verify(`${longer}.${mac}`)).toBeNull();
    expect(auth.verify(`${token}x`)).toBeNull();
    expect(auth.verify(token.split('.')[0]!)).toBeNull();
    expect(auth.verify('')).toBeNull();
    expect(auth.verify('a.b.c')).toBeNull();
  });

  it('rejects tokens of a revoked device at once', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(auth.createCode({ owner: false }).code, 'iPad', jwk)!;
    const { token } = (await session(auth, device.id, sign))!;
    auth.revokeDevice(device.id);
    expect(auth.verify(token)).toBeNull();
    expect(auth.devices()).toEqual([]);
  });

  it('keeps only code hashes on disk, with private file modes, and survives a restart', async () => {
    const auth = new Auth(new Store(tmp), now);
    const { code, record } = auth.createCode({ owner: true });
    const unused = auth.createCode({ owner: false });
    const { jwk, sign } = await deviceKey();
    const device = auth.redeem(code, 'Mac', jwk)!;
    const { token } = (await session(auth, device.id, sign))!;

    const raw = readFileSync(join(tmp, 'auth.json'), 'utf8');
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(unused.code);
    expect(raw).toContain(unused.record.hash);
    expect(statSync(join(tmp, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, 'secret')).mode & 0o777).toBe(0o600);

    const again = new Auth(new Store(tmp), now);
    expect(again.verify(token)?.id).toBe(device.id);
    expect(again.devices().map((d) => d.id)).toEqual([device.id]);
    expect(again.codes().map((c) => c.id)).toEqual([unused.record.id]);
    expect(again.redeem(code, 'Mac', jwk)).toBeNull();
    expect(record.owner).toBe(true);
  });

  it('sees codes made by another process on the same data dir', async () => {
    const server = new Auth(new Store(tmp), now);
    server.devices();
    const cli = new Auth(new Store(tmp), now);
    const { code } = cli.createCode({ owner: true });
    expect(server.redeem(code, 'Mac', (await deviceKey()).jwk)?.owner).toBe(true);
  });

  it('deletes codes and drops expired ones from the list', () => {
    const auth = new Auth(new Store(tmp), now);
    const a = auth.createCode({ owner: false });
    const b = auth.createCode({ owner: false });
    auth.deleteCode(a.record.id);
    expect(auth.codes().map((c) => c.id)).toEqual([b.record.id]);
    clock += 10 * MINUTE;
    expect(auth.codes()).toEqual([]);
  });
});

describe('HTTP', () => {
  let base = '';
  let close: (() => void) | undefined;
  let auth: Auth;
  let library: Library;
  afterEach(() => close?.());

  async function start(opts: { registrar?: CodeRegistrar; trustProxy?: (address: string) => boolean } = {}): Promise<void> {
    auth = new Auth(new Store(join(tmp, 'data')), now);
    library = new Library([], join(tmp, 'data', 'library.json'), { scanPauseMs: 0 });
    const server = createServer(
      appHandlers({ auth, library, now, publicBase: 'https://nas.example/bluray/api/', registrar: opts.registrar, trustProxy: opts.trustProxy }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => {
      server.close();
      server.closeAllConnections();
    };
  }

  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  async function pairedToken(owner: boolean): Promise<string> {
    const { jwk, sign } = await deviceKey();
    const { code } = auth.createCode({ owner });
    const redeemed = await post('/api/pair/redeem', { code, deviceName: owner ? 'Mac' : 'Phone', publicKeyJwk: jwk });
    expect(redeemed.status).toBe(200);
    const { deviceId, owner: isOwner } = (await redeemed.json()) as { deviceId: string; owner: boolean };
    expect(isOwner).toBe(owner);
    const { challenge } = (await (await post('/api/session/challenge', { deviceId })).json()) as { challenge: string };
    const res = await post('/api/session', { deviceId, challenge, signature: await sign(challenge) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    expect(body.expiresAt).toBe(clock + 60 * MINUTE);
    return body.token;
  }

  it('answers health and redeem without a token', async () => {
    await start();
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    await pairedToken(false);
  });

  it('answers 401 to the library without a valid token, and the listing with one', async () => {
    await start();
    const res = await fetch(`${base}/api/library`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect((await fetch(`${base}/api/library?t=nope`)).status).toBe(401);
    expect((await fetch(`${base}/api/anything-else`)).status).toBe(401);

    const token = await pairedToken(false);
    expect((await fetch(`${base}/api/library?t=${encodeURIComponent(token)}`)).status).toBe(200);
    expect((await fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    clock += 60 * MINUTE;
    expect((await fetch(`${base}/api/library?t=${encodeURIComponent(token)}`)).status).toBe(401);
  });

  it('answers 403 to a non-owner on every admin route', async () => {
    await start();
    const token = await pairedToken(false);
    const auth = { Authorization: `Bearer ${token}` };
    const calls: [string, string][] = [
      ['GET', '/api/admin/devices'],
      ['GET', '/api/admin/codes'],
      ['POST', '/api/admin/codes'],
      ['DELETE', '/api/admin/devices/x'],
      ['DELETE', '/api/admin/codes/x'],
      ['POST', '/api/admin/rescan'],
    ];
    for (const [method, path] of calls) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{"owner":false}' : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await fetch(`${base}${path}`, { method })).status, `${method} ${path} without a token`).toBe(401);
    }
  });

  it('lets an owner list, mint, delete and revoke', async () => {
    const registrar = { registerCode: vi.fn(async () => {}) };
    await start({ registrar });
    const token = await pairedToken(true);
    const headers = { Authorization: `Bearer ${token}` };

    const minted = await post('/api/admin/codes', { owner: false }, headers);
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { code: string; link: string; expiresAt: number; rendezvous: boolean };
    expect(body.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(body.link).toBe(`https://bluray-web.pages.dev/?pair=${body.code.replaceAll('-', '')}`);
    expect(body.expiresAt).toBe(clock + 10 * MINUTE);
    expect(body.rendezvous).toBe(true);
    const codeHashArg = registrar.registerCode.mock.calls[0] as unknown as [string, { https: string }, number];
    expect(codeHashArg[1]).toEqual({ https: 'https://nas.example/bluray/api/' });
    expect(codeHashArg[2]).toBe(body.expiresAt);
    expect(codeHashArg[0]).toMatch(/^[0-9a-f]{64}$/);

    const codes = (await (await fetch(`${base}/api/admin/codes`, { headers })).json()) as { codes: { id: string; owner: boolean; expiresAt: number }[] };
    expect(codes.codes).toHaveLength(1);
    expect(codes.codes[0]).toEqual({ id: expect.any(String), owner: false, expiresAt: body.expiresAt });
    expect((await fetch(`${base}/api/admin/codes/${codes.codes[0]!.id}`, { method: 'DELETE', headers })).status).toBe(204);
    expect((await fetch(`${base}/api/admin/codes/${codes.codes[0]!.id}`, { method: 'DELETE', headers })).status).toBe(404);
    expect((await post('/api/pair/redeem', { code: body.code, deviceName: 'x', publicKeyJwk: (await deviceKey()).jwk })).status).toBe(401);

    const phone = await pairedToken(false);
    const devices = (await (await fetch(`${base}/api/admin/devices`, { headers })).json()) as {
      devices: { id: string; name: string; owner: boolean; pairedAt: number; lastSeen: number }[];
    };
    expect(devices.devices.map((d) => d.name)).toEqual(['Mac', 'Phone']);
    expect(Object.keys(devices.devices[0]!).sort()).toEqual(['id', 'lastSeen', 'name', 'owner', 'pairedAt']);
    const phoneId = devices.devices[1]!.id;
    expect((await fetch(`${base}/api/admin/devices/${phoneId}`, { method: 'DELETE', headers })).status).toBe(204);
    expect((await fetch(`${base}/api/library?t=${encodeURIComponent(phone)}`)).status).toBe(401);

    const scan = vi.spyOn(library, 'scan');
    expect((await fetch(`${base}/api/admin/rescan`, { method: 'POST', headers })).status).toBe(202);
    expect(scan).toHaveBeenCalledOnce();
  });

  it('still returns the code when the rendezvous registration fails, or with no registrar', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await start({ registrar: { registerCode: async () => Promise.reject(new Error('down')) } });
    const headers = { Authorization: `Bearer ${await pairedToken(true)}` };
    const res = await post('/api/admin/codes', { owner: true }, headers);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rendezvous: boolean }).rendezvous).toBe(false);
    expect(errors).toHaveBeenCalled();
    close!();

    await start();
    const res2 = await post('/api/admin/codes', { owner: false }, { Authorization: `Bearer ${await pairedToken(true)}` });
    expect(((await res2.json()) as { rendezvous: boolean }).rendezvous).toBe(false);
  });

  it('refuses an admin token passed in the query', async () => {
    await start();
    const token = await pairedToken(true);
    expect((await fetch(`${base}/api/admin/devices?t=${encodeURIComponent(token)}`)).status).toBe(401);
  });

  it('checks request bodies', async () => {
    await start();
    expect((await fetch(`${base}/api/pair/redeem`, { method: 'POST', body: '{}' })).status).toBe(415);
    expect((await fetch(`${base}/api/pair/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await post('/api/pair/redeem', { code: 'x' })).status).toBe(400);
    expect((await post('/api/pair/redeem', { code: 'x', deviceName: 'y', publicKeyJwk: { kty: 'EC' } })).status).toBe(400);
    expect((await post('/api/pair/redeem', { pad: 'x'.repeat(17_000) })).status).toBe(413);
    expect((await post('/api/session/challenge', { deviceId: 'nobody' })).status).toBe(401);
    expect((await post('/api/session', { deviceId: 'nobody', challenge: 'c', signature: 's' })).status).toBe(401);
  });

  it('allows 10 failed redeems a minute per client, then 429', async () => {
    await start();
    const { jwk } = await deviceKey();
    const bad = { code: 'K7QM-4XP2-R9TD', deviceName: 'x', publicKeyJwk: jwk };
    for (let i = 0; i < 10; i++) expect((await post('/api/pair/redeem', bad)).status).toBe(401);
    const { code } = auth.createCode({ owner: false });
    const blocked = await post('/api/pair/redeem', { ...bad, code });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    clock += MINUTE;
    expect((await post('/api/pair/redeem', { ...bad, code })).status).toBe(200);
  });

  it('counts failures per forwarded client when the request comes through the proxy', async () => {
    await start({ trustProxy: (address) => address === '127.0.0.1' || address === '::ffff:127.0.0.1' });
    const { jwk } = await deviceKey();
    const bad = { code: 'K7QM-4XP2-R9TD', deviceName: 'x', publicKeyJwk: jwk };
    for (let i = 0; i < 10; i++) expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': '100.64.0.1, 172.18.0.2' })).status).toBe(401);
    expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': '100.64.0.1' })).status).toBe(429);
    expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': '100.64.0.2' })).status).toBe(401);
  });

  it('ignores X-Forwarded-For from an untrusted peer', async () => {
    await start({ trustProxy: () => false });
    const { jwk } = await deviceKey();
    const bad = { code: 'K7QM-4XP2-R9TD', deviceName: 'x', publicKeyJwk: jwk };
    for (let i = 0; i < 10; i++) expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': `100.64.0.${i}` })).status).toBe(401);
    expect((await post('/api/pair/redeem', bad, { 'X-Forwarded-For': '100.64.0.99' })).status).toBe(429);
  });
});

describe('owner-code', () => {
  it('prints an owner code that the server in the same data dir redeems', async () => {
    const lines: string[] = [];
    ownerCode(tmp, now, (line) => lines.push(line));
    const code = /^Owner pairing code: ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})$/.exec(lines[0]!)?.[1];
    expect(code).toBeDefined();
    expect(lines[1]).toBe(`Pairing link: https://bluray-web.pages.dev/?pair=${code!.replaceAll('-', '')}`);
    expect(lines[2]).toMatch(/^Expires: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d /);
    expect(lines[4]).toMatch(/^[█▀▄ \n]+$/);
    const server = new Auth(new Store(tmp), now);
    expect(server.redeem(code!, 'Mac', (await deviceKey()).jwk)?.owner).toBe(true);
  });
});
