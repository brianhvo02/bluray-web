import { beforeEach, describe, expect, it } from 'vitest';
import { CodeRegistry } from './code-registry';
import worker from './index';
import type { Env } from './index';
import { memoryState } from './memory-state';
import type { MemoryStorage } from './memory-state';
import { base64url, codeHashOf, signedMessage } from './protocol';

const MINUTE = 60_000;
const CODE = 'K7QM4XP2R9TD';
/** Shared with server/src/codes.test.ts: both runtimes must hash a code identically. */
const CODE_HASH = '0f54f555d41af4fe0469424a47ffcbfb19a84d3629a0cbc0ffa8385557ea6dbf';
const APP = 'https://bluray-web.pages.dev';
const ROUTES = { https: 'https://nas.example/bluray/api/' };

let clock: number;
let storage: MemoryStorage;
let registry: CodeRegistry;
let env: Env;

beforeEach(() => {
  clock = 1_800_000_000_000;
  const state = memoryState();
  storage = state.storage;
  registry = new CodeRegistry(state, undefined, () => clock);
  env = {
    CODE_REGISTRY: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: (request: Request) => registry.fetch(request) }),
    },
  };
});

function call(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(
    new Request(`https://rendezvous.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function lookup(code: string, ip = '203.0.113.7'): Promise<Response> {
  return call('/codes/lookup', { code }, { 'CF-Connecting-IP': ip, Origin: APP });
}

async function nasKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
}

async function registerNas(keys: CryptoKeyPair): Promise<string> {
  const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
  const res = await call('/nas', { publicKeyJwk: { kty, crv, x, y } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { nasId: string }).nasId;
}

async function signedCode(
  keys: CryptoKeyPair,
  fields: { nasId: string; codeHash: string; routes: { https?: string }; expiresAt: number },
): Promise<Record<string, unknown>> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signedMessage(fields));
  return { ...fields, signature: base64url(new Uint8Array(signature)) };
}

async function registerCode(keys: CryptoKeyPair, nasId: string, expiresAt = clock + 10 * MINUTE, codeHash = CODE_HASH): Promise<Response> {
  return call('/codes', await signedCode(keys, { nasId, codeHash, routes: ROUTES, expiresAt }));
}

describe('protocol', () => {
  it('hashes a code as hex SHA-256 of its normalized form (shared test vector)', async () => {
    expect(await codeHashOf('k7qm-4xp2-r9td')).toBe(CODE_HASH);
    expect(await codeHashOf('not a code')).toBeNull();
  });
});

describe('rendezvous', () => {
  it('finds a NAS by a code typed lower-case with dashes', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    expect(nasId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await registerCode(keys, nasId)).status).toBe(204);

    const res = await lookup('k7qm-4xp2-r9td');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nasId, routes: ROUTES });
    // A lookup doesn't consume the code; the NAS's redeem does.
    expect((await lookup(CODE)).status).toBe(200);
  });

  it('gives the same id when a NAS registers its key again', async () => {
    const keys = await nasKey();
    expect(await registerNas(keys)).toBe(await registerNas(keys));
  });

  it('rejects a bad signature with 401', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    const body = await signedCode(keys, { nasId, codeHash: CODE_HASH, routes: ROUTES, expiresAt: clock + 10 * MINUTE });
    expect((await call('/codes', { ...body, routes: { https: 'https://evil.example/' } })).status).toBe(401);
    const other = await signedCode(await nasKey(), { nasId, codeHash: CODE_HASH, routes: ROUTES, expiresAt: clock + 10 * MINUTE });
    expect((await call('/codes', other)).status).toBe(401);
    expect((await lookup(CODE)).status).toBe(404);
  });

  it('rejects a code from an unknown NAS with 401', async () => {
    const keys = await nasKey();
    expect((await registerCode(keys, 'A'.repeat(43))).status).toBe(401);
  });

  it('rejects an expiry in the past or more than 15 minutes ahead, so a captured request cannot be replayed later', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    expect((await registerCode(keys, nasId, clock - 1)).status).toBe(400);
    expect((await registerCode(keys, nasId, clock + 15 * MINUTE + 1)).status).toBe(400);
    expect((await registerCode(keys, nasId, clock + 15 * MINUTE)).status).toBe(204);
  });

  it("won't let one NAS take over another NAS's code", async () => {
    const a = await nasKey();
    const b = await nasKey();
    const nasA = await registerNas(a);
    const nasB = await registerNas(b);
    expect((await registerCode(a, nasA)).status).toBe(204);
    expect((await registerCode(b, nasB)).status).toBe(409);
    expect(await (await lookup(CODE)).json()).toEqual({ nasId: nasA, routes: ROUTES });
  });

  it('answers 404 for an unknown code or an expired one, and the alarm deletes expired codes', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    await registerCode(keys, nasId, clock + 10 * MINUTE);
    expect(storage.alarm).toBe(clock + 10 * MINUTE);
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ')).status).toBe(404);
    expect((await lookup('not a code')).status).toBe(404);

    clock += 10 * MINUTE;
    expect((await lookup(CODE, '198.51.100.1')).status).toBe(404);
    await registry.alarm();
    expect([...storage.data.keys()].filter((k) => k.startsWith('code:'))).toEqual([]);
  });

  it('answers 429 to the 11th lookup from one IP within a minute, and lets it through a minute later', async () => {
    for (let i = 0; i < 10; i++) expect((await lookup('ZZZZ-ZZZZ-ZZZZ')).status).toBe(404);
    const limited = await lookup('ZZZZ-ZZZZ-ZZZZ');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ', '203.0.113.8')).status).toBe(404);
    clock += MINUTE;
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ')).status).toBe(404);
  });

  it('answers 429 to the 1,001st lookup within an hour from many IPs', async () => {
    for (let i = 0; i < 1000; i++) {
      clock += 1000;
      expect((await lookup('ZZZZ-ZZZZ-ZZZZ', `10.0.${i >> 8}.${i & 255}`)).status).toBe(404);
    }
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ', '192.0.2.1')).status).toBe(429);
    clock += 60 * MINUTE - 1000 * 1000 + 1000;
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ', '192.0.2.1')).status).toBe(404);
  });

  it('stores code hashes only, never codes', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    await registerCode(keys, nasId);
    await lookup('k7qm-4xp2-r9td');
    const dump = JSON.stringify([...storage.data]);
    expect(dump).toContain(CODE_HASH);
    expect(dump).not.toMatch(/K7QM-?4XP2-?R9TD/i);
  });

  it('rejects malformed requests with 400 and unknown routes with 404', async () => {
    expect((await call('/nas', { publicKeyJwk: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' } })).status).toBe(400);
    expect((await call('/codes', { nasId: 1 })).status).toBe(400);
    expect((await call('/codes/lookup', 'K7QM4XP2R9TD')).status).toBe(400);
    expect((await call('/elsewhere', {})).status).toBe(404);
    const get = await worker.fetch(new Request('https://rendezvous.example/codes/lookup'), env);
    expect(get.status).toBe(405);
  });
});

describe('CORS', () => {
  it.each([APP, 'https://fix-x.bluray-web.pages.dev', 'http://localhost:5173', 'http://localhost:4173'])('allows %s', async (origin) => {
    const res = await call('/codes/lookup', { code: CODE }, { Origin: origin });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });

  it.each(['https://evil.pages.dev', 'https://bluray-web.pages.dev.evil.com'])('gives no Allow-Origin to %s', async (origin) => {
    const res = await call('/codes/lookup', { code: CODE }, { Origin: origin });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('answers a preflight for an app origin', async () => {
    const res = await worker.fetch(
      new Request('https://rendezvous.example/codes/lookup', {
        method: 'OPTIONS',
        headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('600');
  });
});
