import type { CodeLookup, DiscEntry, DiscManifest, FolderEntry } from '../../engine/disc/nas-api';
import { PAIRING_CODE_LENGTH, formatCode, normalizeCode } from '../../engine/disc/pairing-code';
import type { NasPairing, NasStore } from './nas-store';

export const NAS_MESSAGES = {
  invalidCode: "That code didn't work. Codes last 10 minutes; ask for a new one.",
  tooMany: 'Too many tries. Wait a minute and try again.',
  noRoute: "This NAS isn't reachable from here yet.",
  noRendezvous: "Pairing by code isn't available right now.",
  unpaired: 'This device is no longer paired with the NAS.',
  /** Shown while the first request to the NAS is pending: browsers hold it until local network access is answered. */
  allowLocalNetwork: 'Allow local network access if your browser asks.',
  unreachable: "Couldn't reach the NAS. If your browser asked about local network access, allow it, and check that this device is on your tailnet.",
} as const;

/** The NAS answered with an error status other than the ones the client handles itself. */
export class NasHttpError extends Error {
  constructor(
    readonly status: number,
    /** The `error` field of the JSON body, e.g. 'disc-changed'. */
    readonly code: string | null,
  ) {
    super(`The NAS answered ${status}${code ? ` (${code})` : ''}.`);
  }
}

export interface NasSession {
  readonly token: string;
  readonly expiresAt: number;
}

export interface NasDevice {
  readonly id: string;
  readonly name: string;
  readonly owner: boolean;
  readonly pairedAt: number;
  readonly lastSeen: number;
}

export interface NasCode {
  readonly id: string;
  readonly owner: boolean;
  readonly expiresAt: number;
}

export interface NasClientDeps {
  readonly fetch: typeof fetch;
  readonly subtle: SubtleCrypto;
  readonly store: NasStore;
  readonly now: () => number;
  /** The rendezvous service; unset or empty means pairing by code is unavailable. */
  readonly rendezvousUrl: string | undefined;
}

const MINUTE = 60_000;
/** Sessions last an hour; a token is replaced once it has less than this left. */
const REFRESH_MARGIN_MS = 5 * MINUTE;
/** Browsers hold the first request to the NAS until local network access is answered (Chrome >70 s, Firefox up to 300 s). */
const FIRST_REQUEST_TIMEOUT_MS = 20_000;
const ECDSA_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/** Pairing with the NAS, its sessions and its API. Every browser API comes in through `deps`. */
export class NasClient {
  private cached: NasSession | null = null;
  private pending: Promise<NasSession> | null = null;

  readonly admin = {
    devices: async (): Promise<NasDevice[]> => ((await this.json('admin/devices')) as { devices: NasDevice[] }).devices,
    codes: async (): Promise<NasCode[]> => ((await this.json('admin/codes')) as { codes: NasCode[] }).codes,
    createCode: async (owner: boolean): Promise<{ code: string; link: string; expiresAt: number }> =>
      (await this.json('admin/codes', jsonPost({ owner }))) as { code: string; link: string; expiresAt: number },
    revokeDevice: async (id: string): Promise<void> => {
      await this.ok(`admin/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    deleteCode: async (id: string): Promise<void> => {
      await this.ok(`admin/codes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    rescan: async (): Promise<void> => {
      await this.ok('admin/rescan', { method: 'POST' });
    },
  };

  constructor(private readonly deps: NasClientDeps) {}

  /** Whether a rendezvous service is configured, without which codes can't be looked up. */
  get canPairByCode(): boolean {
    return Boolean(this.deps.rendezvousUrl?.trim());
  }

  /** The stored pairing, or null when this device isn't paired. */
  pairing(): Promise<NasPairing | null> {
    return this.deps.store.get();
  }

  /** Where a code leads, from the rendezvous service; the code is normalized first. */
  async lookup(code: string): Promise<CodeLookup> {
    const normalized = normalizeCode(code);
    if (normalized === null) throw new Error(NAS_MESSAGES.invalidCode);
    const service = this.deps.rendezvousUrl?.trim().replace(/\/+$/, '');
    if (!service) throw new Error(NAS_MESSAGES.noRendezvous);
    const { fetch: doFetch } = this.deps;
    let res: Response;
    try {
      res = await doFetch(`${service}/codes/lookup`, jsonPost({ code: normalized }));
    } catch {
      throw new Error(NAS_MESSAGES.noRendezvous);
    }
    if (res.status === 404) throw new Error(NAS_MESSAGES.invalidCode);
    if (res.status === 429) throw new Error(NAS_MESSAGES.tooMany);
    if (!res.ok) throw new Error(NAS_MESSAGES.noRendezvous);
    return (await res.json()) as CodeLookup;
  }

  /** Looks the code up, makes this device's non-extractable P-256 key pair and redeems the code with the NAS. */
  async pair(code: string, deviceName: string): Promise<void> {
    const found = await this.lookup(code);
    const https = found.routes.https;
    if (!https) throw new Error(NAS_MESSAGES.noRoute);
    const base = https.endsWith('/') ? https : `${https}/`;
    const key = await this.deps.subtle.generateKey(ECDSA_KEY, false, ['sign', 'verify']);
    const { kty, crv, x, y } = await this.deps.subtle.exportKey('jwk', key.publicKey);
    const name = deviceName.trim();
    const res = await this.request(
      `${base}pair/redeem`,
      jsonPost({ code: normalizeCode(code), deviceName: name, publicKeyJwk: { kty, crv, x, y } }),
      FIRST_REQUEST_TIMEOUT_MS,
    );
    if (res.status === 401) throw new Error(NAS_MESSAGES.invalidCode);
    if (res.status === 429) throw new Error(NAS_MESSAGES.tooMany);
    if (!res.ok) throw new NasHttpError(res.status, await errorCode(res));
    const { deviceId, owner } = (await res.json()) as { deviceId: string; owner: boolean };
    this.cached = null;
    this.pending = null;
    await this.deps.store.put({ base, deviceId, deviceName: name, owner, key });
  }

  /** A session token, reused until 5 minutes before it expires; concurrent callers share one refresh. */
  session(): Promise<NasSession> {
    if (this.cached && this.deps.now() < this.cached.expiresAt - REFRESH_MARGIN_MS) return Promise.resolve(this.cached);
    this.pending ??= this.startSession().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async library(path: string): Promise<{ folders: FolderEntry[]; discs: DiscEntry[]; scanning: boolean }> {
    return (await this.json(`library?path=${encodeURIComponent(path)}`)) as { folders: FolderEntry[]; discs: DiscEntry[]; scanning: boolean };
  }

  async manifest(discId: string): Promise<DiscManifest> {
    return (await this.json(`discs/${encodeURIComponent(discId)}/manifest`)) as DiscManifest;
  }

  /** Throughput of reading the probe (the first 4 MiB of the disc's largest clip), in megabits per second. */
  async probe(discId: string): Promise<{ mbps: number }> {
    const started = this.deps.now();
    const res = await this.authed(`discs/${encodeURIComponent(discId)}/probe`, {}, true);
    if (!res.ok) throw new NasHttpError(res.status, await errorCode(res));
    const bytes = (await res.arrayBuffer()).byteLength;
    const seconds = Math.max(this.deps.now() - started, 1) / 1000;
    return { mbps: (bytes * 8) / 1e6 / seconds };
  }

  private async startSession(): Promise<NasSession> {
    const pairing = await this.deps.store.get();
    if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
    const challengeRes = await this.request(`${pairing.base}session/challenge`, jsonPost({ deviceId: pairing.deviceId }));
    if (challengeRes.status === 401) return this.unpaired();
    if (!challengeRes.ok) throw new NasHttpError(challengeRes.status, await errorCode(challengeRes));
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const signature = await this.deps.subtle.sign(ECDSA_SIGN, pairing.key.privateKey, new TextEncoder().encode(challenge));
    const res = await this.request(
      `${pairing.base}session`,
      jsonPost({ deviceId: pairing.deviceId, challenge, signature: base64url(new Uint8Array(signature)) }),
    );
    if (res.status === 401) return this.unpaired();
    if (!res.ok) throw new NasHttpError(res.status, await errorCode(res));
    const session = (await res.json()) as NasSession;
    this.cached = session;
    return session;
  }

  /** Forgets the pairing the NAS no longer knows. */
  private async unpaired(): Promise<never> {
    this.cached = null;
    await this.deps.store.clear();
    throw new Error(NAS_MESSAGES.unpaired);
  }

  /**
   * `path` under the NAS base with the session token (as `Authorization: Bearer`, or `t=` for disc reads).
   * A 401 gets one retry with a fresh session (the token may have lapsed); a second 401 means the device was revoked.
   */
  private async authed(path: string, init: RequestInit = {}, viaQuery = false): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const { token } = await this.session();
      const pairing = await this.deps.store.get();
      if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
      const url = viaQuery ? `${pairing.base}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : `${pairing.base}${path}`;
      const headers = new Headers(init.headers);
      if (!viaQuery) headers.set('Authorization', `Bearer ${token}`);
      const res = await this.request(url, { ...init, headers });
      if (res.status !== 401) return res;
      this.cached = null;
      if (attempt > 0) return this.unpaired();
    }
  }

  private async ok(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.authed(path, init);
    if (!res.ok) throw new NasHttpError(res.status, await errorCode(res));
    return res;
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    return (await this.ok(path, init)).json();
  }

  /** fetch, with a network failure (or the timeout, when given) reported as the NAS being unreachable. */
  private async request(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const { fetch: doFetch } = this.deps;
    const controller = new AbortController();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof TypeError || controller.signal.aborted) throw new Error(NAS_MESSAGES.unreachable);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** What the code field shows for `raw`: upper case, dashes and spaces dropped, at most 12 characters, grouped by four. */
export function groupCodeInput(raw: string): string {
  return formatCode(raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, PAIRING_CODE_LENGTH));
}

/** A short label for this device, the default device name: 'iPad', 'iPhone', 'Mac Safari', 'Firefox', … */
export function defaultDeviceName(userAgent: string, maxTouchPoints: number): string {
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return 'iPad';
  if (/iPhone|iPod/.test(userAgent)) return 'iPhone';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  const os = /Macintosh/.test(userAgent) ? 'Mac' : /Windows/.test(userAgent) ? 'Windows' : /CrOS/.test(userAgent) ? 'Chromebook' : /Linux/.test(userAgent) ? 'Linux' : '';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  return os ? `${os} ${browser}` : browser;
}
