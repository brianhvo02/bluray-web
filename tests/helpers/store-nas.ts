/// <reference types="node" />
/**
 * The NAS's BD-J store for tests, the real thing: the server's own app (server/src: people and devices in Auth, the
 * per-person BdjStore, its routes and tar rules) over node:http on a free port, with a fetch that can make requests
 * fail the ways a NAS fails (busy, unreachable, a token gone stale). Every name here is made up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appHandlers } from '../../server/src/app';
import { Auth } from '../../server/src/auth';
import { BdjStore } from '../../server/src/bdj-store';
import { createServer, json, type Handler } from '../../server/src/http';
import { Library } from '../../server/src/library';
import { requestDevice } from '../../server/src/routes/titles';
import { Store } from '../../server/src/store';

export type StoreNasFault = 'busy' | 'unreachable';

export interface StoreNas {
  /** The API base, as the player derives it from a disc's base: `http://127.0.0.1:<port>/api/`. */
  readonly api: string;
  /** Requests through `fetch`, with faults and stale tokens applied. */
  readonly fetch: typeof fetch;
  /** `METHOD /path` of each request `fetch` sent on, in order (no query). */
  readonly requests: string[];
  /** A new person (not an owner) with one paired device: its id and token. */
  person(name: string): Promise<{ readonly personId: string; readonly deviceId: string; readonly token: string }>;
  /** Another device of `personId`: its token. */
  device(personId: string, name: string): Promise<string>;
  /** Moves a device to another person, as the owner's People screen does (Auth.moveDevice): its token follows. */
  move(deviceId: string, personId: string): void;
  /** The next requests to the store or `me` fail so, one fault each. */
  fail(...faults: StoreNasFault[]): void;
  /** The next PUTs to the store fail so, one fault each (other requests go through). */
  failPut(...faults: StoreNasFault[]): void;
  /** Requests carrying `token` go out with a token the server does not know (its 401), until it is refreshed. */
  expire(token: string): void;
  /** What the server holds for a person's scope. */
  stored(personId: string, scope: string): { readonly etag: string | null; readonly body: Buffer };
  close(): Promise<void>;
}

export async function startStoreNas(opts: { scopeLimit?: number; personLimit?: number } = {}): Promise<StoreNas> {
  const tmp = mkdtempSync(join(tmpdir(), 'store-nas-'));
  const data = join(tmp, 'data');
  const auth = new Auth(new Store(data), Date.now);
  const bdjStore = new BdjStore(data, opts);
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  // `GET me` is the title routes' (routes/titles.ts), which need the title library; this answers its person fields the
  // same way, from the same device lookup
  const me: Handler = async (req, url) => {
    if (url.pathname !== '/api/me') return null;
    const device = requestDevice(auth, req.headers.authorization, url);
    return device ? json(200, { owner: device.owner, titleLibrary: false, personId: device.personId, personName: device.personName }) : json(401, { error: 'unauthorized' });
  };
  const server = createServer([me, ...appHandlers({ auth, library, bdjStore, publicBase: 'https://nas.example/bluray/api/' })]);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  const faults: StoreNasFault[] = [];
  const putFaults: StoreNasFault[] = [];
  const expired = new Set<string>();
  const requests: string[] = [];

  const pair = async (code: string, name: string): Promise<{ deviceId: string; token: string }> => {
    const pairKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pairKey.publicKey);
    const device = auth.redeem(code, name, jwk)!;
    const challenge = auth.challenge(device.id)!;
    const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pairKey.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
    return { deviceId: device.id, token: auth.startSession(device.id, challenge, signature)!.token };
  };

  const storeFetch = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    requests.push(`${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`);
    const method = (init.method ?? 'GET').toUpperCase();
    const fault =
      (method === 'PUT' && url.pathname.startsWith('/api/bdj-store/') ? putFaults.shift() : undefined) ??
      (url.pathname.startsWith('/api/bdj-store/') || url.pathname === '/api/me' ? faults.shift() : undefined);
    if (fault === 'unreachable') throw new TypeError('fetch failed');
    if (fault === 'busy') return Response.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': '1' } });
    const token = url.searchParams.get('t');
    if (token !== null && expired.has(token)) url.searchParams.set('t', 'stale-token');
    return fetch(url, init);
  }) as typeof fetch;

  return {
    api,
    fetch: storeFetch,
    requests,
    async person(name) {
      const { code, person } = auth.createCode({ newPerson: { name, owner: false } });
      return { personId: person.id, ...(await pair(code, `${name}'s phone`)) };
    },
    async device(personId, name) {
      return (await pair(auth.createCode({ personId }).code, name)).token;
    },
    move: (deviceId, personId) => auth.moveDevice(deviceId, personId),
    fail: (...f) => void faults.push(...f),
    failPut: (...f) => void putFaults.push(...f),
    expire: (token) => void expired.add(token),
    stored: (personId, scope) => bdjStore.get(personId, scope),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
