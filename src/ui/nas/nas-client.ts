import type { CodeLookup, DiscEntry, DiscManifest, FolderEntry, TitleDetail, TitleSummary } from '../../engine/disc/nas-api';
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

/** `GET me`: whether this device is an owner, and whether the title library is open to it. */
export interface NasMe {
  readonly owner: boolean;
  readonly titleLibrary: boolean;
}

/** `GET admin/metadata/status`: the title matcher's progress and counts. */
export interface NasTitleStatus {
  readonly running: boolean;
  readonly groupsDone: number;
  readonly groupsTotal: number;
  readonly filed: number;
  readonly unsorted: number;
  readonly music: number;
  readonly lastRunAt: number | null;
  readonly tmdb: boolean;
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

/** A disc's routes, relative to the NAS base. */
const discPath = (discId: string): string => `discs/${encodeURIComponent(discId)}/`;

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

/** A stored record usable as a pairing: a missing or damaged key pair (say, after storage was tampered with) is not. */
function isPairing(value: unknown): value is NasPairing {
  if (typeof value !== 'object' || value === null) return false;
  const { base, deviceId, deviceName, owner, key } = value as Partial<Record<keyof NasPairing, unknown>>;
  const k = key as Partial<CryptoKeyPair> | null | undefined;
  return (
    typeof base === 'string' &&
    typeof deviceId === 'string' &&
    typeof deviceName === 'string' &&
    typeof owner === 'boolean' &&
    k?.privateKey instanceof CryptoKey &&
    k.publicKey instanceof CryptoKey
  );
}

/** Pairing with the NAS, its sessions and its API. Every browser API comes in through `deps`. */
export class NasClient {
  private cached: NasSession | null = null;
  private pending: Promise<NasSession> | null = null;
  /** The pairing once loaded from the store (null: not paired); undefined until then. */
  private current: NasPairing | null | undefined = undefined;
  private loading: Promise<NasPairing | null> | null = null;
  /** Bumped whenever the pairing changes, so work begun for an older pairing can't touch the new one. */
  private generation = 0;
  private readonly unpairedListeners = new Set<() => void>();

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
    titleStatus: async (): Promise<NasTitleStatus> => (await this.json('admin/metadata/status')) as NasTitleStatus,
  };

  constructor(private readonly deps: NasClientDeps) {}

  /** Whether a rendezvous service is configured, without which codes can't be looked up. */
  get canPairByCode(): boolean {
    return Boolean(this.deps.rendezvousUrl?.trim());
  }

  /** The pairing, or null when this device isn't paired. Read from the store once; a damaged record is cleared. */
  pairing(): Promise<NasPairing | null> {
    if (this.current !== undefined) return Promise.resolve(this.current);
    this.loading ??= this.loadPairing().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Calls `listener` whenever the NAS turns out to have forgotten this device. Returns the unsubscribe function. */
  onUnpaired(listener: () => void): () => void {
    this.unpairedListeners.add(listener);
    return () => {
      this.unpairedListeners.delete(listener);
    };
  }

  /** Forgets the pairing on this device (the NAS keeps it until an owner removes it). */
  async forget(): Promise<void> {
    this.reset(null);
    await this.deps.store.clear();
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
    const pairing: NasPairing = { base, deviceId, deviceName: name, owner, key };
    await this.deps.store.put(pairing);
    this.reset(pairing);
  }

  /** A session token, reused until 5 minutes before it expires; concurrent callers share one refresh. */
  session(): Promise<NasSession> {
    if (this.cached && this.deps.now() < this.cached.expiresAt - REFRESH_MARGIN_MS) return Promise.resolve(this.cached);
    if (!this.pending) {
      const pending = this.startSession().finally(() => {
        if (this.pending === pending) this.pending = null;
      });
      this.pending = pending;
    }
    return this.pending;
  }

  /**
   * A session for the engine after the NAS refused `staleToken`: never that token again, even while it looks fresh to
   * a device clock running slow against the NAS's.
   */
  freshSession(staleToken: string): Promise<NasSession> {
    if (this.cached?.token === staleToken) this.cached = null;
    return this.session();
  }

  async library(path: string): Promise<{ folders: FolderEntry[]; discs: DiscEntry[]; scanning: boolean }> {
    return (await this.json(`library?path=${encodeURIComponent(path)}`)) as { folders: FolderEntry[]; discs: DiscEntry[]; scanning: boolean };
  }

  /** Whether this device is an owner, and whether it may browse by title (the release gate). */
  async me(): Promise<NasMe> {
    return (await this.json('me')) as NasMe;
  }

  /** Every title, with its names in all languages (searched locally). */
  async titles(): Promise<TitleSummary[]> {
    return ((await this.json('titles')) as { titles: TitleSummary[] }).titles;
  }

  /** A title's seasons, movies and extras. */
  async title(id: string): Promise<TitleDetail> {
    return (await this.json(`titles/${encodeURIComponent(id)}`)) as TitleDetail;
  }

  /** An `<img src>` for a poster or banner: the session token goes in `t=`, as images can't send headers. */
  async artUrl(artId: string, size: 'small' | 'large'): Promise<string> {
    const [session, pairing] = await Promise.all([this.session(), this.pairing()]);
    if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
    return `${pairing.base}art/${encodeURIComponent(artId)}?size=${size}&t=${encodeURIComponent(session.token)}`;
  }

  /** The disc's API base for the engine (`RemoteDiscSpec.base`): `<NAS base>discs/<id>/`. */
  async discBase(discId: string): Promise<string> {
    const pairing = await this.pairing();
    if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
    return `${pairing.base}${discPath(discId)}`;
  }

  async manifest(discId: string): Promise<DiscManifest> {
    return (await this.json(`${discPath(discId)}manifest`)) as DiscManifest;
  }

  /** Throughput of reading the probe (the first 4 MiB of the disc's largest clip), in megabits per second. */
  async probe(discId: string): Promise<{ mbps: number }> {
    const started = this.deps.now();
    const res = await this.authed(`${discPath(discId)}probe`, {}, true);
    if (!res.ok) throw new NasHttpError(res.status, await errorCode(res));
    const bytes = (await res.arrayBuffer()).byteLength;
    const seconds = Math.max(this.deps.now() - started, 1) / 1000;
    return { mbps: (bytes * 8) / 1e6 / seconds };
  }

  private async loadPairing(): Promise<NasPairing | null> {
    const generation = this.generation;
    const stored = await this.deps.store.get();
    if (generation !== this.generation) return this.current ?? null;
    const pairing = isPairing(stored) ? stored : null;
    if (stored && !pairing) await this.deps.store.clear();
    if (generation !== this.generation) return this.current ?? null;
    this.current = pairing;
    return pairing;
  }

  private reset(pairing: NasPairing | null): void {
    this.generation++;
    this.current = pairing;
    this.cached = null;
    this.pending = null;
  }

  private async startSession(): Promise<NasSession> {
    const generation = this.generation;
    const pairing = await this.pairing();
    if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
    const challengeRes = await this.request(`${pairing.base}session/challenge`, jsonPost({ deviceId: pairing.deviceId }));
    if (challengeRes.status === 401) return this.unpaired(generation);
    if (!challengeRes.ok) throw new NasHttpError(challengeRes.status, await errorCode(challengeRes));
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    let signature: ArrayBuffer;
    try {
      signature = await this.deps.subtle.sign(ECDSA_SIGN, pairing.key.privateKey, new TextEncoder().encode(challenge));
    } catch {
      // The stored key can't sign (damaged storage): the pairing is unusable.
      return this.unpaired(generation);
    }
    const res = await this.request(
      `${pairing.base}session`,
      jsonPost({ deviceId: pairing.deviceId, challenge, signature: base64url(new Uint8Array(signature)) }),
    );
    if (res.status === 401) return this.unpaired(generation);
    if (!res.ok) throw new NasHttpError(res.status, await errorCode(res));
    const session = (await res.json()) as NasSession;
    if (generation === this.generation) this.cached = session;
    return session;
  }

  /** Forgets a pairing the NAS no longer knows (or that can't sign), unless it was replaced meanwhile, and tells the listeners. */
  private async unpaired(generation: number): Promise<never> {
    if (generation === this.generation) {
      this.reset(null);
      await this.deps.store.clear();
      for (const listener of this.unpairedListeners) listener();
    }
    throw new Error(NAS_MESSAGES.unpaired);
  }

  /**
   * `path` under the NAS base with the session token (as `Authorization: Bearer`, or `t=` for disc reads).
   * A 401 gets one retry with a fresh session (the token may have lapsed); a second 401 means the device was revoked.
   */
  private async authed(path: string, init: RequestInit = {}, viaQuery = false): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const generation = this.generation;
      const session = await this.session();
      const pairing = await this.pairing();
      if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
      const { token } = session;
      const url = viaQuery ? `${pairing.base}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : `${pairing.base}${path}`;
      const headers = new Headers(init.headers);
      if (!viaQuery) headers.set('Authorization', `Bearer ${token}`);
      const res = await this.request(url, { ...init, headers });
      if (res.status !== 401) return res;
      if (this.cached?.token === token) this.cached = null;
      if (attempt > 0) return this.unpaired(generation);
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
