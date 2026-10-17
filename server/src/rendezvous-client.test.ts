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
    expect(await res.json()).toEqual({ nasId: await client.ensureRegistered(), routes: ROUTES });
  });

  it('re-registers the NAS when the service has forgotten it', async () => {
    const client = new RendezvousClient(BASE, keyFile, workerFetch);
    await client.ensureRegistered();
    registry = new CodeRegistry(memoryState());
    await client.registerCode(codeHash('K7QM4XP2R9TD'), ROUTES, Date.now() + 10 * 60_000);
    expect(requests).toEqual(['POST /nas', 'POST /codes', 'POST /nas', 'POST /codes']);
    expect((await lookup('K7QM4XP2R9TD')).status).toBe(200);
  });

  it('throws when the service refuses the code', async () => {
    const client = new RendezvousClient(BASE, keyFile, workerFetch);
    await expect(client.registerCode(codeHash('K7QM4XP2R9TD'), ROUTES, Date.now() + 60 * 60_000)).rejects.toThrow(/400/);
  });

  it('throws when the service is unreachable', async () => {
    const down = vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(new RendezvousClient(BASE, keyFile, down).ensureRegistered()).rejects.toThrow('fetch failed');
  });
});
