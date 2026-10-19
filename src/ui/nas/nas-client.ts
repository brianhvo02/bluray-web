import type { CodeLookup, DiscEntry, DiscManifest, DiscRef, FolderEntry, OwnerChoice, OwnTitle, TitleDetail, TitleKind, TitleSummary, UnsortedItem } from '../../engine/disc/nas-api';
import { PAIRING_CODE_LENGTH, formatCode, normalizeCode } from '../../engine/disc/pairing-code';
import type { NasPairing, NasStore } from './nas-store';
import { codeHashOf, turnProofMessage } from '../../../rendezvous/src/protocol';
import { NAS_LOST_MESSAGE } from '../../engine/disc/http-transport';
import { RTC_BASE, RTC_UNREACHABLE, RtcConnection } from './rtc/rtc-connection';
import type { DeviceProof, RtcLink, RtcOpenOptions } from './rtc/rtc-connection';
import { chooseRoute, chooseWebRtc, routeKey } from './route-choice';
import type { Route, RouteDeps } from './route-choice';

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

/** The WebRTC connection to the NAS closed while the request was in flight; the next request connects again. */
export class NasLostError extends Error {
  readonly reason = 'nas-lost';
  constructor() {
    super(NAS_LOST_MESSAGE);
  }
}

/** The NAS answered with an error status other than the ones the client handles itself. */
export class NasHttpError extends Error {
  constructor(
    readonly status: number,
    /** The `error` field of the JSON body, e.g. 'disc-changed'. */
    readonly code: string | null,
    /** `Retry-After` in seconds on a 429, and the body's `source` (a disc id) on 409 copy-follows-source. */
    readonly detail: { readonly retryAfter?: number; readonly source?: string } = {},
  ) {
    super(`The NAS answered ${status}${code ? ` (${code})` : ''}.`);
  }
}

export interface NasSession {
  readonly token: string;
  readonly expiresAt: number;
}

/** One of a person's paired devices, as `GET admin/people` lists it. */
export interface NasPersonDevice {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: number;
  readonly lastSeen: number;
}

/** A person on the NAS: their devices, and the size of their BD-J saved data. */
export interface NasPerson {
  readonly id: string;
  readonly name: string;
  readonly owner: boolean;
  readonly createdAt: number;
  readonly savedBytes: number;
  readonly devices: readonly NasPersonDevice[];
}

/** Who a new pairing code is for: someone on the NAS, or a person made with the code. */
export type NasCodeTarget = { readonly personId: string } | { readonly newPerson: { readonly name: string; readonly owner: boolean } };

/** `POST admin/codes`: the code, its link, and the person a device pairing with it becomes. */
export interface NasMintedCode {
  readonly code: string;
  readonly link: string;
  readonly expiresAt: number;
  readonly rendezvous: boolean;
  readonly personId: string;
  readonly personName: string;
  readonly invite: boolean;
}

/** `GET me`: whether this device is an owner, whether the title library is open to it, and whose device it is. */
export interface NasMe {
  readonly owner: boolean;
  readonly titleLibrary: boolean;
  readonly personId: string;
  readonly personName: string;
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
  /** The release gate in effect: the owner's setting, else the server's `TITLE_LIBRARY`. */
  readonly gate: 'owners' | 'everyone';
}

export interface NasCode {
  readonly id: string;
  readonly personId: string;
  readonly personName: string;
  readonly invite: boolean;
  readonly expiresAt: number;
}

export interface NasClientDeps {
  readonly fetch: typeof fetch;
  readonly subtle: SubtleCrypto;
  readonly store: NasStore;
  readonly now: () => number;
  /** The rendezvous service; unset or empty means pairing by code is unavailable. */
  readonly rendezvousUrl: string | undefined;
  /** Opens a WebRTC connection to the NAS; `RtcConnection.open` by default. */
  readonly openRtc?: (opts: RtcOpenOptions) => Promise<RtcLink>;
  /** Object URLs for art fetched over WebRTC; `URL.createObjectURL`/`revokeObjectURL` by default. */
  readonly objectUrls?: { create(blob: Blob): string; revoke(url: string): void };
}

/** `rtc://<nasId>/…`: a URL that goes through the WebRTC connection to that NAS. */
const RTC_URL = /^rtc:\/\/([^/]+)\//;
/** Art fetched over WebRTC is kept as this many object URLs; older ones are revoked. */
const ART_URLS = 64;
/** `authed` gives up (as nas-lost) after this many tries when the connection keeps changing under it. */
const AUTHED_TRIES = 4;

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

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const jsonPost = (body: unknown): RequestInit => jsonBody('POST', body);

async function errorCode(res: Response): Promise<string | null> {
  return (await httpError(res)).code;
}

/** The error a refused request throws, with its `error` code, `Retry-After` and `source` when present. */
async function httpError(res: Response): Promise<NasHttpError> {
  let body: { error?: unknown; source?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // no JSON body
  }
  const retry = Number(res.headers.get('Retry-After') ?? NaN);
  return new NasHttpError(res.status, typeof body.error === 'string' ? body.error : null, {
    ...(Number.isFinite(retry) && retry >= 0 ? { retryAfter: retry } : {}),
    ...(typeof body.source === 'string' ? { source: body.source } : {}),
  });
}

/** A disc's owner-choice route. */
const choicePath = (discId: string): string => `admin/discs/${encodeURIComponent(discId)}/choice`;

/** Why "apply to the group" left a disc as it was: its own choice, or a copy following its source (rulings T9f, T9i). */
export interface SkippedDisc {
  readonly discId: string;
  /**
   * `no-number`: other discs of the folder have a number in their names and this one hasn't (I3). `conflict`: the disc
   * filed has no number in its name, and this one's own number is the one given to it (N3).
   */
  readonly reason: 'direct' | 'copy' | 'no-number' | 'conflict';
}

/**
 * A stored record usable as a pairing: a missing or damaged key pair (say, after storage was tampered with) is not.
 * A pairing stored before people has no `personName`, and stays usable.
 */
function isPairing(value: unknown): value is NasPairing {
  if (typeof value !== 'object' || value === null) return false;
  const { base, nasId, deviceId, deviceName, personName, owner, key } = value as Partial<Record<keyof NasPairing, unknown>>;
  const k = key as Partial<CryptoKeyPair> | null | undefined;
  return (
    typeof base === 'string' &&
    (nasId === undefined || typeof nasId === 'string') &&
    (base !== '' || typeof nasId === 'string') &&
    typeof deviceId === 'string' &&
    typeof deviceName === 'string' &&
    (personName === undefined || typeof personName === 'string') &&
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
  /** The route chosen per NAS (`chooseRoute`), for the page's life. */
  private readonly routes = new Map<string, Promise<Route>>();
  /** Open WebRTC connections by NAS id; `rtc://<nasId>/` URLs go through them. */
  private readonly links = new Map<string, RtcLink>();
  /** The connection each session was started on: the NAS lets a channel's requests through only after a session on it. */
  private readonly sessionLinks = new WeakMap<NasSession, RtcLink>();
  /** Object URLs of art fetched over WebRTC, least recently used first. */
  private readonly artUrls = new Map<string, string>();

  readonly admin = {
    people: async (): Promise<NasPerson[]> => ((await this.json('admin/people')) as { people: NasPerson[] }).people,
    createPerson: async (name: string, owner: boolean): Promise<NasPerson> => (await this.json('admin/people', jsonPost({ name, owner }))) as NasPerson,
    /** Renames a person or makes them an owner or not; leaving no owner device is refused with 409 `last-owner`. */
    updatePerson: async (id: string, change: { readonly name?: string; readonly owner?: boolean }): Promise<NasPerson> =>
      (await this.json(`admin/people/${encodeURIComponent(id)}`, jsonBody('PATCH', change))) as NasPerson,
    /** Removes a person, unpairing their devices and deleting their saved data. */
    removePerson: async (id: string): Promise<void> => {
      await this.ok(`admin/people/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    clearSavedData: async (id: string): Promise<void> => {
      await this.ok(`admin/people/${encodeURIComponent(id)}/saved-data`, { method: 'DELETE' });
    },
    moveDevice: async (id: string, personId: string): Promise<void> => {
      await this.ok(`admin/devices/${encodeURIComponent(id)}`, jsonBody('PATCH', { personId }));
    },
    codes: async (): Promise<NasCode[]> => ((await this.json('admin/codes')) as { codes: NasCode[] }).codes,
    /** A pairing code for a person, or for a new one; an invite lasts 3 days, a plain code 10 minutes. */
    createCode: async (target: NasCodeTarget, invite: boolean): Promise<NasMintedCode> =>
      (await this.json('admin/codes', jsonPost({ ...target, invite }))) as NasMintedCode,
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
    unsorted: async (offset: number, limit: number): Promise<{ items: UnsortedItem[]; total: number }> =>
      (await this.json(`admin/unsorted?offset=${offset}&limit=${limit}`)) as { items: UnsortedItem[]; total: number },
    hidden: async (): Promise<DiscRef[]> => ((await this.json('admin/hidden')) as { discs: DiscRef[] }).discs,
    /** AniList, TMDB or own titles through the NAS; refusals come as NasHttpError 429 (with `retryAfter`) or 503. */
    lookup: async (q: string, source: 'anilist' | 'tmdb' | 'own'): Promise<TitleSummary[]> =>
      ((await this.json(`admin/lookup?q=${encodeURIComponent(q)}&source=${source}`)) as { titles: TitleSummary[] }).titles,
    /** Files a disc; with `applyToGroup`, the other discs of its folder too, resolving to those left as they were. */
    setChoice: async (discId: string, choice: OwnerChoice, applyToGroup = false): Promise<SkippedDisc[]> => {
      const res = await this.ok(choicePath(discId), jsonBody('PUT', applyToGroup ? { choice, applyToGroup } : { choice }));
      return applyToGroup ? ((await res.json()) as { skipped: SkippedDisc[] }).skipped : [];
    },
    /** Clears a disc's choice; a copy following its source is refused with 409 `copy-follows-source` (ruling T9b). */
    clearChoice: async (discId: string): Promise<void> => {
      await this.ok(choicePath(discId), { method: 'DELETE' });
    },
    /** A music title's or disc's display name; null brings the folder name back. */
    setName: async (id: string, name: string | null): Promise<void> => {
      await this.ok(`admin/names/${encodeURIComponent(id)}`, jsonBody('PUT', { name }));
    },
    createTitle: async (kind: TitleKind, name: string, seasons: number | null): Promise<OwnTitle> =>
      (await this.json('admin/titles', jsonBody('POST', kind === 'series' ? { kind, name, seasons } : { kind, name }))) as OwnTitle,
    /** Renames an own title, or changes an own series' number of seasons. */
    updateTitle: async (id: string, change: { readonly name?: string; readonly seasons?: number }): Promise<OwnTitle> =>
      (await this.json(`admin/titles/${encodeURIComponent(id)}`, jsonBody('PATCH', change))) as OwnTitle,
    deleteTitle: async (id: string): Promise<void> => {
      await this.ok(`admin/titles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    /** The release gate: who may browse by title. */
    setTitleLibrary: async (gate: 'owners' | 'everyone'): Promise<void> => {
      await this.ok('admin/settings/title-library', jsonBody('PUT', { gate }));
    },
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

  /**
   * Looks the code up, makes this device's non-extractable P-256 key pair and redeems the code with the NAS: over HTTPS
   * when it answers its check, else over a WebRTC connection opened with the code's hash (so an invite may use the
   * relay), which is closed once the code is redeemed.
   */
  async pair(code: string, deviceName: string): Promise<void> {
    const found = await this.lookup(code);
    const https = found.routes.https;
    const nasId = found.routes.webrtc?.nasId;
    if (!https && nasId === undefined) throw new Error(NAS_MESSAGES.noRoute);
    const base = !https ? '' : https.endsWith('/') ? https : `${https}/`;
    const target = { base, ...(nasId === undefined ? {} : { nasId }) };
    const inviteHash = (await codeHashOf(code)) ?? undefined;
    const route = await chooseRoute(target, { fetch: this.deps.fetch, connect: (id) => this.connect(id, { inviteHash }) });
    let pairing: NasPairing;
    try {
      const apiBase = route.kind === 'https' ? route.base : RTC_BASE(nasId!);
      const key = await this.deps.subtle.generateKey(ECDSA_KEY, false, ['sign', 'verify']);
      const { kty, crv, x, y } = await this.deps.subtle.exportKey('jwk', key.publicKey);
      const name = deviceName.trim();
      const res = await this.request(
        `${apiBase}pair/redeem`,
        jsonPost({ code: normalizeCode(code), deviceName: name, publicKeyJwk: { kty, crv, x, y } }),
        FIRST_REQUEST_TIMEOUT_MS,
      );
      if (res.status === 401) throw new Error(NAS_MESSAGES.invalidCode);
      if (res.status === 429) throw new Error(NAS_MESSAGES.tooMany);
      if (!res.ok) throw new NasHttpError(res.status, await errorCode(res));
      // An older NAS answers without a person.
      const { deviceId, owner, personName } = (await res.json()) as { deviceId: string; owner: boolean; personName?: string };
      pairing = { ...target, deviceId, deviceName: name, ...(typeof personName === 'string' ? { personName } : {}), owner, key };
    } finally {
      if (route.kind === 'webrtc') route.connection.close();
    }
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

  /**
   * Whether this device is an owner, whether it may browse by title (the release gate), and whose device it is. When
   * the owner status or person name differs from the stored pairing's (changed by an owner, or a pairing stored before
   * people), the stored pairing takes the NAS's, so `pairing()` gives it from then on.
   */
  async me(): Promise<NasMe> {
    const generation = this.generation;
    const me = (await this.json('me')) as NasMe;
    const pairing = this.current;
    if (!pairing || generation !== this.generation) return me;
    const personName = typeof me.personName === 'string' ? me.personName : pairing.personName;
    const owner = typeof me.owner === 'boolean' ? me.owner : pairing.owner;
    if (personName !== pairing.personName || owner !== pairing.owner) {
      const updated: NasPairing = { ...pairing, owner, ...(personName === undefined ? {} : { personName }) };
      this.current = updated;
      await this.deps.store.put(updated);
    }
    return me;
  }

  /** Every title, with its names in all languages (searched locally). */
  async titles(): Promise<TitleSummary[]> {
    return ((await this.json('titles')) as { titles: TitleSummary[] }).titles;
  }

  /** A title's seasons, movies and extras. */
  async title(id: string): Promise<TitleDetail> {
    return (await this.json(`titles/${encodeURIComponent(id)}`)) as TitleDetail;
  }

  /**
   * An `<img src>` for a poster or banner. Over HTTPS the session token goes in `t=`, as images can't send headers;
   * over WebRTC the art is fetched through the connection and given as an object URL (the last 64 are kept).
   */
  async artUrl(artId: string, size: 'small' | 'large'): Promise<string> {
    const pairing = await this.pairing();
    if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
    const base = await this.apiBase(pairing);
    const path = `art/${encodeURIComponent(artId)}?size=${size}`;
    if (!RTC_URL.test(base)) return `${base}${path}&t=${encodeURIComponent((await this.session()).token)}`;
    const hit = this.artUrls.get(path);
    if (hit !== undefined) {
      this.artUrls.delete(path);
      this.artUrls.set(path, hit);
      return hit;
    }
    const generation = this.generation;
    const blob = await (await this.ok(path)).blob();
    const urls = this.objectUrls;
    const raced = this.artUrls.get(path);
    if (raced !== undefined) return raced; // another call fetched it meanwhile
    const url = urls.create(blob);
    if (generation !== this.generation) {
      urls.revoke(url);
      throw new Error(NAS_MESSAGES.unpaired);
    }
    this.artUrls.set(path, url);
    for (const [key, old] of this.artUrls) {
      if (this.artUrls.size <= ART_URLS) break;
      this.artUrls.delete(key);
      urls.revoke(old);
    }
    return url;
  }

  /**
   * `failedUrl` (an artUrl) again: with a fresh token, as the one it carried may have lapsed since it was made, or,
   * for an object URL, fetched again.
   */
  async freshArtUrl(artId: string, size: 'small' | 'large', failedUrl: string): Promise<string> {
    if (failedUrl.startsWith('blob:')) {
      for (const [key, url] of this.artUrls) {
        if (url !== failedUrl) continue;
        this.artUrls.delete(key);
        this.objectUrls.revoke(url);
      }
      return this.artUrl(artId, size);
    }
    const stale = new URL(failedUrl).searchParams.get('t');
    if (stale !== null) await this.freshSession(stale);
    return this.artUrl(artId, size);
  }

  /** The disc's API base for the engine (`RemoteDiscSpec.base`): `<NAS base>discs/<id>/`. */
  async discBase(discId: string): Promise<string> {
    const pairing = await this.pairing();
    if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
    return `${await this.apiBase(pairing)}${discPath(discId)}`;
  }

  /**
   * The engine's fetch for disc reads: plain fetch on HTTPS, and for `rtc://` URLs the NAS's current connection,
   * looked up on every call. When there is none it connects again over WebRTC, never HTTPS (whose base the open disc
   * doesn't use), and makes that the NAS's route, so the next session starts on it; while it can't connect, and when
   * the connection closes under a request, it fails as nas-lost.
   */
  readonly discFetch: typeof fetch = async (input, init) => {
    const url = typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
    const rtc = RTC_URL.exec(url);
    if (!rtc) return this.deps.fetch(input, init);
    const nasId = rtc[1];
    let link = this.links.get(nasId);
    if (!link) {
      const pairing = await this.pairing();
      if (pairing?.nasId === nasId) {
        try {
          await chooseWebRtc(pairing, this.routeDeps(pairing));
        } catch {
          throw new NasLostError();
        }
        link = this.links.get(nasId);
      }
    }
    if (!link) throw new NasLostError();
    try {
      return await link.fetch(input, init);
    } catch (err) {
      throw link.closed ? new NasLostError() : err;
    }
  };

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
    this.routes.clear();
    for (const link of [...this.links.values()]) link.close();
    this.links.clear();
    for (const url of this.artUrls.values()) this.objectUrls.revoke(url);
    this.artUrls.clear();
  }

  private get objectUrls(): { create(blob: Blob): string; revoke(url: string): void } {
    return this.deps.objectUrls ?? { create: (blob) => URL.createObjectURL(blob), revoke: (url) => URL.revokeObjectURL(url) };
  }

  /** The connection `base` goes through now, if it is an `rtc://` base. */
  private linkFor(base: string): RtcLink | undefined {
    const rtc = RTC_URL.exec(base);
    return rtc ? this.links.get(rtc[1]) : undefined;
  }

  /** The API base to use for `pairing` now: its HTTPS base, or `rtc://<nasId>/api/` over a WebRTC connection. */
  private async apiBase(pairing: NasPairing): Promise<string> {
    const route = await chooseRoute(pairing, this.routeDeps(pairing));
    return route.kind === 'https' ? route.base : RTC_BASE(pairing.nasId!);
  }

  /** The route choice's dependencies for a paired device: its proof for TURN, and this client's cache. */
  private routeDeps(pairing: NasPairing): RouteDeps {
    return {
      fetch: this.deps.fetch,
      connect: (nasId) => this.connect(nasId, { deviceProof: (sid) => this.deviceProof(pairing, sid) }),
      cache: this.routes,
    };
  }

  /**
   * Opens a WebRTC connection to `nasId` and routes its `rtc://` URLs through it until it closes. The session is
   * dropped, as the NAS lets a new channel's requests through only after a session on it.
   */
  private async connect(nasId: string, auth: Pick<RtcOpenOptions, 'deviceProof' | 'inviteHash'>): Promise<RtcLink> {
    const service = this.deps.rendezvousUrl?.trim();
    if (!service) throw new Error(NAS_MESSAGES.noRoute);
    const generation = this.generation;
    const open = this.deps.openRtc ?? ((opts: RtcOpenOptions) => RtcConnection.open(opts));
    const link = await open({ nasId, signallingUrl: service, ...auth });
    if (generation !== this.generation) {
      link.close(); // the pairing changed while it opened
      throw new NasLostError();
    }
    const replaced = this.links.get(nasId);
    if (replaced && replaced !== link) replaced.close();
    this.links.set(nasId, link);
    this.cached = null;
    link.onClose(() => {
      if (this.links.get(nasId) === link) this.links.delete(nasId);
    });
    return link;
  }

  /** A paired device's proof for a TURN request on the signalling socket `sid`. */
  private async deviceProof(pairing: NasPairing, sid: string): Promise<DeviceProof> {
    const ts = this.deps.now();
    const signature = await this.deps.subtle.sign(ECDSA_SIGN, pairing.key.privateKey, turnProofMessage({ sid, ts }));
    return { deviceId: pairing.deviceId, ts, signature: base64url(new Uint8Array(signature)) };
  }

  private async startSession(): Promise<NasSession> {
    const generation = this.generation;
    const pairing = await this.pairing();
    if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
    const base = await this.apiBase(pairing);
    const challengeRes = await this.request(`${base}session/challenge`, jsonPost({ deviceId: pairing.deviceId }));
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
    const link = this.linkFor(base);
    const res = await this.request(
      `${base}session`,
      jsonPost({ deviceId: pairing.deviceId, challenge, signature: base64url(new Uint8Array(signature)) }),
    );
    if (res.status === 401) return this.unpaired(generation);
    if (!res.ok) throw new NasHttpError(res.status, await errorCode(res));
    const session = (await res.json()) as NasSession;
    if (link) this.sessionLinks.set(session, link);
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
   * Over WebRTC the session must have been started on the connection in use: when the connection changes under a
   * request (a drop and a reconnect), it starts again, and a 401 from the new connection isn't counted.
   */
  private async authed(path: string, init: RequestInit = {}, viaQuery = false): Promise<Response> {
    let refused = 0;
    for (let attempt = 0; attempt < AUTHED_TRIES; attempt++) {
      const generation = this.generation;
      const pairing = await this.pairing();
      if (!pairing) throw new Error(NAS_MESSAGES.unpaired);
      const base = await this.apiBase(pairing);
      const session = await this.session();
      const link = this.linkFor(base);
      if (this.sessionLinks.get(session) !== link) {
        // started on another connection (or over HTTPS): this one hasn't seen it
        if (this.cached === session) this.cached = null;
        continue;
      }
      const { token } = session;
      const url = viaQuery ? `${base}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : `${base}${path}`;
      const headers = new Headers(init.headers);
      if (!viaQuery) headers.set('Authorization', `Bearer ${token}`);
      const res = await this.request(url, { ...init, headers });
      if (res.status !== 401) return res;
      if (this.cached?.token === token) this.cached = null;
      if (this.linkFor(base) !== link || link?.closed) continue; // the connection changed: not a revocation
      if (++refused > 1) return this.unpaired(generation);
    }
    throw new NasLostError();
  }

  private async ok(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.authed(path, init);
    if (!res.ok) throw await httpError(res);
    return res;
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.ok(path, init);
    try {
      return await res.json();
    } catch (err) {
      // the connection closed while the body was coming
      throw (err as { reason?: unknown } | null)?.reason === 'nas-lost' ? new NasLostError() : err;
    }
  }

  /**
   * fetch, with a network failure (or the timeout, when given) reported as the NAS being unreachable. `rtc://` URLs go
   * through their NAS's WebRTC connection, and fail as NasLostError when it has closed. A failed HTTPS request makes
   * the next one choose its route again.
   */
  private async request(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const rtc = /^rtc:\/\/([^/]+)\//.exec(url);
    const link = rtc ? this.links.get(rtc[1]) : undefined;
    if (rtc && !link) throw new NasLostError();
    const doFetch = link ? link.fetch : this.deps.fetch;
    const controller = new AbortController();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (link) throw link.closed ? new NasLostError() : new Error(RTC_UNREACHABLE);
      if (err instanceof TypeError || controller.signal.aborted) {
        if (this.current) this.routes.delete(routeKey(this.current));
        throw new Error(NAS_MESSAGES.unreachable);
      }
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
