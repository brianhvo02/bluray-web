import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHandlers } from '../../../server/src/app';
import { Auth } from '../../../server/src/auth';
import { codeHash } from '../../../server/src/codes';
import { HttpError, json } from '../../../server/src/http';
import type { Response as ServerResponse } from '../../../server/src/http';
import type { Library } from '../../../server/src/library';
import { Store } from '../../../server/src/store';
import type { CodeLookup, CodeRoutes } from '../../engine/disc/nas-api';
import { normalizeCode } from '../../engine/disc/pairing-code';
import { NAS_MESSAGES, NasClient, defaultDeviceName, groupCodeInput } from './nas-client';
import type { NasPairing, NasStore } from './nas-store';

const RENDEZVOUS = 'https://rendezvous.example';
const BASE = 'https://nas.example/bluray/api/';
const MINUTE = 60_000;

let tmp: string;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nas-client-'));
  clock = 1_800_000_000_000;
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

function memoryStore(): NasStore & { value: NasPairing | null } {
  return {
    value: null,
    async get() {
      return this.value;
    },
    async put(pairing) {
      this.value = pairing;
    },
    async clear() {
      this.value = null;
    },
  };
}

interface FakeServer {
  readonly auth: Auth;
  readonly fetch: typeof fetch;
  /** Registers a fresh code with the rendezvous service and returns it. */
  code(routes?: CodeRoutes): Promise<string>;
  /** NAS requests by route, e.g. 'session' → 2. */
  readonly hits: Record<string, number>;
  /** Folder paths the library was listed at. */
  readonly listed: string[];
  /** Answer rendezvous lookups with 429. */
  lookupRateLimited: boolean;
  /** Overrides for NAS requests (not rendezvous). */
  nas?: (url: URL, init?: RequestInit) => Promise<Response>;
}

/**
 * The rendezvous Worker's lookup (a map of code hashes), and the NAS server's real handlers (`appHandlers`:
 * pairing, sessions, the token guard, library) over a real `Auth`, with Caddy's `/bluray` prefix stripped.
 */
function fakeServer(): FakeServer {
  const auth = new Auth(new Store(tmp), now);
  const codes = new Map<string, CodeLookup>();
  const hits: Record<string, number> = {};
  const listed: string[] = [];
  const library = {
    scanning: false,
    list: (path: string) => {
      listed.push(path);
      return { folders: [{ name: 'drv5', path: 'drv5', discs: 1 }], discs: [] };
    },
  } as unknown as Library;
  const handlers = appHandlers({ auth, library, publicBase: BASE, now });

  const serve = async (url: URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? Buffer.from(init.body, 'utf8') : null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
    if (body) headers['content-length'] = String(body.length);
    const path = url.pathname.replace(/^\/bluray/, '') + url.search;
    const req = Object.assign(Readable.from(body ? [body] : []), {
      method: init?.method ?? 'GET',
      url: path,
      headers,
      socket: { remoteAddress: '100.64.0.2' },
    }) as unknown as IncomingMessage;
    let res: ServerResponse | null = null;
    try {
      for (const handler of handlers) if ((res = await handler(req, new URL(path, 'http://localhost')))) break;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      res = json(err.status, { error: err.message }, err.headers);
    }
    res ??= json(404, { error: 'not found' });
    return new Response(typeof res.body === 'string' ? res.body : null, { status: res.status, headers: res.headers });
  };

  const server: FakeServer = {
    auth,
    hits,
    listed,
    lookupRateLimited: false,
    async code(routes = { https: BASE }) {
      const { record, code } = auth.createCode({ owner: true });
      codes.set(record.hash, { nasId: 'nas1', routes });
      return code;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.href.startsWith(RENDEZVOUS)) {
        if (server.lookupRateLimited) return Response.json({ error: 'too many lookups' }, { status: 429 });
        if (url.href !== `${RENDEZVOUS}/codes/lookup` || init?.method !== 'POST') return new Response(null, { status: 404 });
        const { code } = JSON.parse(String(init.body)) as { code: string };
        const found = normalizeCode(code) === null ? undefined : codes.get(codeHash(code));
        return found ? Response.json(found) : Response.json({ error: 'unknown code' }, { status: 404 });
      }
      if (!url.href.startsWith(BASE)) return new Response(null, { status: 404 });
      if (server.nas) return server.nas(url, init);
      const route = url.pathname.slice(new URL(BASE).pathname.length);
      hits[route] = (hits[route] ?? 0) + 1;
      return serve(url, init);
    }) as typeof fetch,
  };
  return server;
}

function client(server: FakeServer, store: NasStore = memoryStore(), rendezvousUrl: string | undefined = RENDEZVOUS): NasClient {
  return new NasClient({ fetch: server.fetch, subtle: crypto.subtle, store, now, rendezvousUrl });
}

describe('NasClient', () => {
  it('pairs, starts a session and lists the library', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'Mac Safari');
    expect(store.value).toMatchObject({ base: BASE, deviceName: 'Mac Safari', owner: true });
    expect(server.auth.devices().map((d) => d.name)).toEqual(['Mac Safari']);
    const session = await nas.session();
    expect(server.auth.verify(session.token)?.id).toBe(store.value!.deviceId);
    const listing = await nas.library('drv5/[BD] 鋼の錬金術師 #1? 100% a+b');
    expect(listing).toEqual({ folders: [{ name: 'drv5', path: 'drv5', discs: 1 }], discs: [], scanning: false });
    expect(server.listed).toEqual(['drv5/[BD] 鋼の錬金術師 #1? 100% a+b']);
  });

  it('keeps the private key non-extractable', async () => {
    const server = fakeServer();
    const store = memoryStore();
    await client(server, store).pair(await server.code(), 'iPad');
    expect(store.value!.key.privateKey.extractable).toBe(false);
  });

  it('reuses a 50-minute-old session and refreshes a 56-minute-old one before use', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    await nas.library('');
    expect(server.hits.session).toBe(1);
    clock += 50 * MINUTE;
    await nas.library('');
    expect(server.hits.session).toBe(1);
    clock += 6 * MINUTE;
    await nas.library('');
    expect(server.hits.session).toBe(2);
  });

  it('shares one session request between concurrent calls', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    await Promise.all([nas.library(''), nas.library('drv5'), nas.session()]);
    expect(server.hits.session).toBe(1);
  });

  it('clears the pairing when the NAS has revoked the device', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'iPad');
    await nas.library('');
    server.auth.revokeDevice(store.value!.deviceId);
    await expect(nas.library('')).rejects.toThrow(NAS_MESSAGES.unpaired);
    expect(NAS_MESSAGES.unpaired).toBe('This device is no longer paired with the NAS.');
    expect(store.value).toBeNull();
    expect(await nas.pairing()).toBeNull();
  });

  it('treats a stored record without a usable key as not paired, and clears it', async () => {
    const server = fakeServer();
    const store = memoryStore();
    store.value = { base: BASE, deviceId: 'd1', deviceName: 'iPad', owner: false, key: {} } as unknown as NasPairing;
    const nas = client(server, store);
    expect(await nas.pairing()).toBeNull();
    expect(store.value).toBeNull();
    await expect(nas.session()).rejects.toThrow(NAS_MESSAGES.unpaired);
  });

  it('forgets a pairing whose key can no longer sign, and tells the listeners', async () => {
    const server = fakeServer();
    const store = memoryStore();
    await client(server, store).pair(await server.code(), 'iPad');
    const { publicKey } = store.value!.key;
    store.value = { ...store.value!, key: { publicKey, privateKey: publicKey } }; // a key that can't sign
    const nas = client(server, store);
    const unpaired = vi.fn();
    nas.onUnpaired(unpaired);
    await expect(nas.library('')).rejects.toThrow(NAS_MESSAGES.unpaired);
    expect(store.value).toBeNull();
    expect(await nas.pairing()).toBeNull();
    expect(unpaired).toHaveBeenCalledTimes(1);
  });

  it('tells the listeners when the NAS has revoked the device', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'iPad');
    const unpaired = vi.fn();
    const unsubscribe = nas.onUnpaired(unpaired);
    server.auth.revokeDevice(store.value!.deviceId);
    await expect(nas.library('')).rejects.toThrow(NAS_MESSAGES.unpaired);
    expect(unpaired).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('reads the pairing from the store once', async () => {
    const server = fakeServer();
    const store = memoryStore();
    await client(server, store).pair(await server.code(), 'iPad');
    const get = vi.spyOn(store, 'get');
    const nas = client(server, store);
    await Promise.all([nas.pairing(), nas.pairing()]);
    await nas.library('');
    await nas.pairing();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('forgets the pairing on request, so the code field can come back', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'iPad');
    await nas.library('');
    await nas.forget();
    expect(store.value).toBeNull();
    expect(await nas.pairing()).toBeNull();
    await expect(nas.library('')).rejects.toThrow(NAS_MESSAGES.unpaired);
    await nas.pair(await server.code(), 'iPad');
    expect((await nas.library('')).folders).toHaveLength(1);
  });

  it("doesn't cache a session started for a pairing forgotten meanwhile", async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const old = nas.session();
    await nas.forget();
    await old;
    await expect(nas.session()).rejects.toThrow(NAS_MESSAGES.unpaired);
  });

  it("keeps a newer session when a request made with an older token gets 401", async () => {
    const server = fakeServer();
    let nas!: NasClient;
    let intercept = true;
    const fetchWithLateRefusal = (async (input: string | URL | Request, init?: RequestInit) => {
      if (intercept && String(input).startsWith(`${BASE}library`)) {
        intercept = false;
        // While this request is out, its token is replaced by a refresh; then the NAS refuses the old token.
        clock += 56 * MINUTE;
        await nas.session();
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    nas = new NasClient({ fetch: fetchWithLateRefusal, subtle: crypto.subtle, store: memoryStore(), now, rendezvousUrl: RENDEZVOUS });
    await nas.pair(await server.code(), 'iPad');
    await nas.session();
    await nas.library('');
    expect(server.hits.session).toBe(2);
  });

  it('gives the engine a new token for the one it reports rejected, even while that one looks fresh (a slow clock)', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const first = await nas.session();
    clock += MINUTE; // tokens are made from the expiry time, so a later session gets another one
    expect((await nas.session()).token).toBe(first.token);
    const fresh = await nas.freshSession(first.token);
    expect(fresh.token).not.toBe(first.token);
    expect(server.hits.session).toBe(2);
    // A rejection of a token already replaced keeps the newer one.
    expect((await nas.freshSession(first.token)).token).toBe(fresh.token);
    expect(server.hits.session).toBe(2);
  });

  it('pairs with a code typed in lower case with spaces', async () => {
    expect(normalizeCode('k7qm 4xp2 r9td')).toBe('K7QM4XP2R9TD');
    const server = fakeServer();
    const store = memoryStore();
    const code = await server.code();
    const typed = `${code.slice(0, 4)} ${code.slice(4, 8)} ${code.slice(8)}`.toLowerCase();
    await client(server, store).pair(typed, 'iPad');
    expect(store.value).not.toBeNull();
  });

  it('answers an unknown or expired code', async () => {
    expect(NAS_MESSAGES.invalidCode).toBe("That code didn't work. Codes last 10 minutes; ask for a new one.");
    const server = fakeServer();
    const nas = client(server);
    await expect(nas.pair('K7QM-4XP2-R9TD', 'iPad')).rejects.toThrow(NAS_MESSAGES.invalidCode);
    await expect(nas.pair('not a code', 'iPad')).rejects.toThrow(NAS_MESSAGES.invalidCode);
    const code = await server.code();
    clock += 11 * MINUTE; // still in the rendezvous map here, but the NAS refuses it
    await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.invalidCode);
  });

  it('answers too many tries, from the rendezvous service or the NAS', async () => {
    expect(NAS_MESSAGES.tooMany).toBe('Too many tries. Wait a minute and try again.');
    const server = fakeServer();
    const nas = client(server);
    const code = await server.code();
    server.lookupRateLimited = true;
    await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.tooMany);
    server.lookupRateLimited = false;
    // The NAS allows 10 failed redeems a minute per client; an expired code fails there.
    clock += 11 * MINUTE;
    for (let i = 0; i < 10; i++) await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.invalidCode);
    await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.tooMany);
  });

  it('answers a lookup without an https route', async () => {
    expect(NAS_MESSAGES.noRoute).toBe("This NAS isn't reachable from here yet.");
    const server = fakeServer();
    const nas = client(server);
    const code = await server.code({ webrtc: true });
    await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.noRoute);
  });

  it('says pairing by code is unavailable without a rendezvous service', async () => {
    const server = fakeServer();
    const nas = client(server, memoryStore(), '');
    await expect(nas.pair(await server.code(), 'iPad')).rejects.toThrow("Pairing by code isn't available right now.");
  });

  it('gives up on the NAS after 20 s while the browser waits on local network access', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = fakeServer();
    let asked!: () => void;
    const reached = new Promise<void>((resolve) => (asked = resolve));
    server.nas = (_url, init) =>
      new Promise((_resolve, reject) => {
        asked();
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const nas = client(server);
    const pairing = nas.pair(await server.code(), 'iPad');
    const outcome = expect(pairing).rejects.toThrow(NAS_MESSAGES.unreachable);
    await reached;
    await vi.advanceTimersByTimeAsync(19_999);
    let settled = false;
    void pairing.catch(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it('says the NAS is unreachable when the browser blocks the request', async () => {
    expect(NAS_MESSAGES.unreachable).toBe(
      "Couldn't reach the NAS. If your browser asked about local network access, allow it, and check that this device is on your tailnet.",
    );
    const server = fakeServer();
    server.nas = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(client(server).pair(await server.code(), 'iPad')).rejects.toThrow(NAS_MESSAGES.unreachable);
  });
});

describe('groupCodeInput', () => {
  it('groups as typed and accepts dashes and spaces', () => {
    expect(groupCodeInput('k7q')).toBe('K7Q');
    expect(groupCodeInput('k7qm4')).toBe('K7QM-4');
    expect(groupCodeInput('k7qm 4xp2-r9td')).toBe('K7QM-4XP2-R9TD');
    expect(groupCodeInput('K7QM-4XP2-R9TDXX')).toBe('K7QM-4XP2-R9TD');
    expect(groupCodeInput('K7QM - 4XP2 - R9TD')).toBe('K7QM-4XP2-R9TD'); // pasted: 18 characters, none lost
  });
});

describe('defaultDeviceName', () => {
  it('names the platform briefly', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    expect(defaultDeviceName(mac, 0)).toBe('Mac Safari');
    expect(defaultDeviceName(mac, 5)).toBe('iPad');
    expect(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 5)).toBe('iPhone');
    expect(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', 0)).toBe('Firefox');
    expect(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 0)).toBe(
      'Windows Chrome',
    );
    expect(defaultDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 5)).toBe(
      'Android',
    );
  });
});
