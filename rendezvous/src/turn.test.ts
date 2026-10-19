import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeRegistry } from './code-registry';
import worker from './index';
import type { Env } from './index';
import { memoryState } from './memory-state';
import { base64url, iceServersOf, signedMessage, turnRequestMessage } from './protocol';
import { CLOUDFLARE_TURN_BASE, turnRoute } from './turn';

// The key id and token are made up; real ones live only in Worker secrets.
const KEY_ID = 'test-key-id';
const TOKEN = 'test-api-token';
const ICE = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
];

let clock: number;
let registry: CodeRegistry;
let env: Env;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  clock = 1_800_000_000_000;
  registry = new CodeRegistry(memoryState(), undefined, () => clock);
  env = {
    CODE_REGISTRY: { idFromName: (name: string) => ({ name }), get: () => ({ fetch: (request: Request) => registry.fetch(request) }) },
    SIGNALLING: { idFromName: (name: string) => ({ name }), get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) },
    TURN_KEY_ID: KEY_ID,
    TURN_KEY_API_TOKEN: TOKEN,
  };
  upstream = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ iceServers: ICE }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function registeredNas(): Promise<{ keys: CryptoKeyPair; nasId: string }> {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
  const res = await registry.fetch(new Request('https://rendezvous.example/nas', { method: 'POST', body: JSON.stringify({ publicKeyJwk: { kty, crv, x, y } }) }));
  return { keys, nasId: ((await res.json()) as { nasId: string }).nasId };
}

async function sign(keys: CryptoKeyPair, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, bytes)));
}

function turn(body: unknown, method = 'POST'): Promise<Response> {
  const request = new Request('https://rendezvous.example/turn', { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  return turnRoute(request, env, { fetch: upstream, now: () => clock });
}

describe('POST /turn', () => {
  it("mints credentials for a NAS's good signature, asking Cloudflare for an hour", async () => {
    const { keys, nasId } = await registeredNas();
    const ts = clock - 30_000;
    const res = await turn({ nasId, ts, signature: await sign(keys, turnRequestMessage({ nasId, ts })) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ iceServers: ICE });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe(`${CLOUDFLARE_TURN_BASE}/${KEY_ID}/credentials/generate-ice-servers`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init?.body as string)).toEqual({ ttl: 3600 });
  });

  it('answers 401 to a stale or future ts, a forged signature, another message signed, or an unknown NAS', async () => {
    const { keys, nasId } = await registeredNas();
    const other = await registeredNas();
    const stale = clock - 61_000;
    const future = clock + 61_000;
    const bodies = [
      { nasId, ts: stale, signature: await sign(keys, turnRequestMessage({ nasId, ts: stale })) },
      { nasId, ts: future, signature: await sign(keys, turnRequestMessage({ nasId, ts: future })) },
      { nasId, ts: clock, signature: await sign(other.keys, turnRequestMessage({ nasId, ts: clock })) },
      { nasId, ts: clock, signature: await sign(keys, signedMessage({ nasId, codeHash: '0'.repeat(64), routes: {}, expiresAt: clock })) },
      { nasId: 'A'.repeat(43), ts: clock, signature: await sign(keys, turnRequestMessage({ nasId: 'A'.repeat(43), ts: clock })) },
    ];
    for (const body of bodies) {
      const res = await turn(body);
      expect(res.status, JSON.stringify(body)).toBe(401);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers 503 turn-not-configured without the secrets, before looking at the request', async () => {
    for (const missing of ['TURN_KEY_ID', 'TURN_KEY_API_TOKEN'] as const) {
      env = { ...env, TURN_KEY_ID: KEY_ID, TURN_KEY_API_TOKEN: TOKEN };
      delete env[missing];
      const res = await turn({});
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'turn-not-configured' });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers 400 to a malformed body, 405 to another method, and 502 when Cloudflare fails', async () => {
    for (const body of [null, [], { nasId: 'x', ts: clock, signature: 's' }, { nasId: 'A'.repeat(43), ts: 'now', signature: 's' }]) {
      expect((await turn(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await turn(undefined, 'GET')).status).toBe(405);
    expect((await turn({ nasId: 'A'.repeat(43), ts: clock, signature: 'x'.repeat(4_096) })).status).toBe(400);

    const { keys, nasId } = await registeredNas();
    const signed = { nasId, ts: clock, signature: await sign(keys, turnRequestMessage({ nasId, ts: clock })) };
    upstream.mockResolvedValueOnce(new Response('{"error":"nope"}', { status: 403 }));
    const refused = await turn(signed);
    expect(refused.status).toBe(502);
    expect(await refused.text()).not.toContain(TOKEN);
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ iceServers: 'x' }), { status: 201 }));
    expect((await turn(signed)).status).toBe(502);
  });

  it('is routed by the Worker, server to server', async () => {
    vi.stubGlobal('fetch', upstream);
    vi.spyOn(Date, 'now').mockReturnValue(clock);
    const { keys, nasId } = await registeredNas();
    const res = await worker.fetch(
      new Request('https://rendezvous.example/turn', {
        method: 'POST',
        body: JSON.stringify({ nasId, ts: clock, signature: await sign(keys, turnRequestMessage({ nasId, ts: clock })) }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { iceServers: unknown[] }).iceServers).toHaveLength(2);
    vi.restoreAllMocks();
  });
});

describe('iceServersOf', () => {
  it('takes up to 16 urls a server and 8 servers', () => {
    const urls = (n: number) => Array.from({ length: n }, (_, i) => `turn:t${i}.example`);
    expect(iceServersOf([{ urls: urls(16) }])).toEqual([{ urls: urls(16) }]);
    expect(iceServersOf([{ urls: urls(17) }])).toBeNull();
    expect(iceServersOf(Array.from({ length: 9 }, () => ({ urls: 'stun:s.example' })))).toBeNull();
    expect(iceServersOf([{ urls: [] }])).toBeNull();
    expect(iceServersOf([{ urls: 'turn:t.example', username: 1 }])).toBeNull();
  });
});
