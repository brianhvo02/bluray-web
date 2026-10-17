import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../server/src/auth';
import { codeHash } from '../../../server/src/codes';
import { bearerToken } from '../../../server/src/routes/admin';
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
  /** Requests by route, e.g. 'session' → 2. */
  readonly hits: Record<string, number>;
  /** Answer the next requests to these routes with 429. */
  readonly rateLimited: Set<string>;
  /** Overrides for NAS requests (not rendezvous). */
  nas?: (url: URL, init?: RequestInit) => Promise<Response>;
}

/** The rendezvous Worker's lookup and the NAS server's pairing, session and library routes, over a real `Auth`. */
function fakeServer(): FakeServer {
  const auth = new Auth(new Store(tmp), now);
  const codes = new Map<string, CodeLookup>();
  const hits: Record<string, number> = {};
  const rateLimited = new Set<string>();
  const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401 });
  const server: FakeServer = {
    auth,
    hits,
    rateLimited,
    async code(routes = { https: BASE }) {
      const { record, code } = auth.createCode({ owner: true });
      codes.set(record.hash, { nasId: 'nas1', routes });
      return code;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, string>) : {};
      if (url.href.startsWith(RENDEZVOUS)) {
        const route = url.href.slice(RENDEZVOUS.length);
        hits[route] = (hits[route] ?? 0) + 1;
        if (rateLimited.has('lookup')) return Response.json({ error: 'too many lookups' }, { status: 429 });
        if (route !== '/codes/lookup' || init?.method !== 'POST') return new Response(null, { status: 404 });
        const found = normalizeCode(body.code ?? '') === null ? undefined : codes.get(codeHash(body.code!));
        return found ? Response.json(found) : Response.json({ error: 'unknown code' }, { status: 404 });
      }
      if (!url.href.startsWith(BASE)) return new Response(null, { status: 404 });
      if (server.nas) return server.nas(url, init);
      const route = url.pathname.slice(new URL(BASE).pathname.length);
      hits[route] = (hits[route] ?? 0) + 1;
      if (rateLimited.has(route)) return Response.json({ error: 'too many tries' }, { status: 429, headers: { 'Retry-After': '60' } });
      switch (`${init?.method ?? 'GET'} ${route}`) {
        case 'POST pair/redeem': {
          const device = auth.redeem(body.code!, body.deviceName!, body.publicKeyJwk as unknown as JsonWebKey);
          return device ? Response.json({ deviceId: device.id, owner: device.owner }) : Response.json({ error: 'invalid code' }, { status: 401 });
        }
        case 'POST session/challenge': {
          const challenge = auth.challenge(body.deviceId!);
          return challenge ? Response.json({ challenge }) : unauthorized();
        }
        case 'POST session': {
          const session = auth.startSession(body.deviceId!, body.challenge!, body.signature!);
          return session ? Response.json(session) : unauthorized();
        }
        case 'GET library': {
          const token = bearerToken(new Headers(init?.headers).get('Authorization') ?? undefined);
          if (token === null || !auth.verify(token)) return unauthorized();
          return Response.json({ folders: [{ name: 'drv5', path: 'drv5', discs: 1 }], discs: [], scanning: false, path: url.searchParams.get('path') });
        }
        default:
          return new Response(null, { status: 404 });
      }
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
    const listing = await nas.library('drv5/[BD] 鋼の錬金術師 #1?');
    expect(listing.folders).toEqual([{ name: 'drv5', path: 'drv5', discs: 1 }]);
    expect((listing as unknown as { path: string }).path).toBe('drv5/[BD] 鋼の錬金術師 #1?');
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
    server.rateLimited.add('lookup');
    await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.tooMany);
    server.rateLimited.clear();
    server.rateLimited.add('pair/redeem');
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
