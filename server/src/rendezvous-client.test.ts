import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeRegistry } from '../../rendezvous/src/code-registry';
import worker from '../../rendezvous/src/index';
import { memoryState } from '../../rendezvous/src/memory-state';
import { codeHash } from './codes';
import { RendezvousClient } from './rendezvous-client';

const BASE = 'https://rendezvous.example/';
const ROUTES = { https: 'https://nas.example/bluray/api/' };

let tmp: string;
let keyFile: string;
let registry: CodeRegistry;
let requests: string[];

/** The Worker's fetch handler in-process, with an in-memory Durable Object behind it. */
const workerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  requests.push(`${request.method} ${new URL(request.url).pathname}`);
  return worker.fetch(request, {
    CODE_REGISTRY: { idFromName: () => ({}), get: () => ({ fetch: (r: Request) => registry.fetch(r) }) },
    SIGNALLING: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(null, { status: 501 }) }) },
  });
}) as typeof fetch;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rendezvous-'));
  keyFile = join(tmp, 'rendezvous-key.json');
  registry = new CodeRegistry(memoryState());
  requests = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function lookup(code: string): Promise<Response> {
  return workerFetch(new URL('codes/lookup', BASE), { method: 'POST', body: JSON.stringify({ code }) });
}

describe('RendezvousClient', () => {
  it('registers the NAS once, keeping its key in a mode-600 file', async () => {
    const client = new RendezvousClient(BASE, keyFile, workerFetch);
    const nasId = await client.ensureRegistered();
    expect(await client.ensureRegistered()).toBe(nasId);
    expect(requests).toEqual(['POST /nas']);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(keyFile, 'utf8')) as { privateKeyJwk: { kty: string; crv: string; d?: string } };
    expect(saved.privateKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(saved.privateKeyJwk.d).toBeDefined();

    // A later process (the server after a restart, or the owner-code command) keeps the same key and id.
    expect(await new RendezvousClient(BASE, keyFile, workerFetch).ensureRegistered()).toBe(nasId);
  });

  it('registers codes the Worker accepts and finds by the code', async () => {
    const client = new RendezvousClient(BASE.slice(0, -1), keyFile, workerFetch);
    await client.registerCode(codeHash('K7QM4XP2R9TD'), ROUTES, Date.now() + 10 * 60_000);
    expect(requests).toEqual(['POST /nas', 'POST /codes']);
    const res = await lookup('k7qm-4xp2-r9td');
    expect(res.status).toBe(200);
    const nasId = await client.ensureRegistered();
    expect(await res.json()).toEqual({ nasId, routes: { ...ROUTES, webrtc: { nasId } } });
  });

  it('re-registers the NAS when the service has forgotten it', async () => {
    const client = new RendezvousClient(BASE, keyFile, workerFetch);
    await client.ensureRegistered();
    registry = new CodeRegistry(memoryState());
    await client.registerCode(codeHash('K7QM4XP2R9TD'), ROUTES, Date.now() + 10 * 60_000);
    expect(requests).toEqual(['POST /nas', 'POST /codes', 'POST /nas', 'POST /codes']);
    expect((await lookup('K7QM4XP2R9TD')).status).toBe(200);
  });

  it('unregisters a code, signed, so lookups stop finding it', async () => {
    const client = new RendezvousClient(BASE, keyFile, workerFetch);
    await client.registerCode(codeHash('K7QM4XP2R9TD'), ROUTES, Date.now() + 10 * 60_000);
    await client.unregisterCode(codeHash('K7QM4XP2R9TD'));
    expect(requests.at(-1)).toBe('DELETE /codes');
    expect((await lookup('K7QM4XP2R9TD')).status).toBe(404);
    await client.unregisterCode(codeHash('K7QM4XP2R9TD'));
  });

  it('throws when the service refuses the code', async () => {
    const client = new RendezvousClient(BASE, keyFile, workerFetch);
    await expect(client.registerCode(codeHash('K7QM4XP2R9TD'), ROUTES, Date.now() + 4 * 24 * 60 * 60_000)).rejects.toThrow(/400/); // past the 3 days and 1 hour allowed
  });

  it('throws when the service is unreachable', async () => {
    const down = vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(new RendezvousClient(BASE, keyFile, down).ensureRegistered()).rejects.toThrow('fetch failed');
  });
});

describe('RendezvousClient.turnServers', () => {
  // A made-up key id and token; real ones live only in Worker secrets.
  const ICE = [{ urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' }];
  let cloudflare: ReturnType<typeof vi.fn<typeof fetch>>;
  const withTurn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return worker.fetch(request, {
      CODE_REGISTRY: { idFromName: () => ({}), get: () => ({ fetch: (r: Request) => registry.fetch(r) }) },
      SIGNALLING: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(null, { status: 501 }) }) },
      TURN_KEY_ID: 'test-key-id',
      TURN_KEY_API_TOKEN: 'test-api-token',
    });
  }) as typeof fetch;

  beforeEach(() => {
    cloudflare = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ iceServers: ICE }), { status: 201 }));
    vi.stubGlobal('fetch', cloudflare);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("gets the Worker's servers with a signed request, registering again once after a lost registry", async () => {
    const client = new RendezvousClient(BASE, keyFile, withTurn);
    expect(await client.turnServers()).toEqual(ICE);
    expect(requests).toEqual(['POST /nas', 'POST /turn']);
    registry = new CodeRegistry(memoryState());
    expect(await client.turnServers()).toEqual(ICE);
    expect(requests).toEqual(['POST /nas', 'POST /turn', 'POST /turn', 'POST /nas', 'POST /turn']);
    expect(cloudflare).toHaveBeenCalledTimes(2);
  });

  it('throws when the Worker has no TURN key', async () => {
    const client = new RendezvousClient(BASE, keyFile, workerFetch);
    await expect(client.turnServers()).rejects.toThrow('rendezvous POST /turn answered 503');
  });
});
