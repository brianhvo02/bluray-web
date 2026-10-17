import type { CodeLookup, CodeRoutes, EcPublicJwk } from '../../src/engine/disc/nas-api';
import { ECDSA_KEY, ECDSA_SIGN, MAX_CODE_AHEAD_MS, codeHashOf, fromBase64url, nasIdOf, signedMessage } from './protocol';

/** The part of a Durable Object's storage API the registry uses (the KV-style API, on SQLite-backed storage). */
export interface RegistryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface RegistryState {
  readonly storage: RegistryStorage;
}

interface NasRecord {
  publicKeyJwk: EcPublicJwk;
}

interface CodeRecord {
  nasId: string;
  routes: CodeRoutes;
  expiresAt: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOOKUPS_PER_IP_PER_MINUTE = 10;
const LOOKUPS_PER_HOUR = 1_000;
const MAX_BODY_BYTES = 4_096;
const MAX_ROUTE_LENGTH = 512;

/** Storage keys: NAS public keys, codes by hash (never the code), and the lookup rate-limit logs. */
const nasKey = (nasId: string): string => `nas:${nasId}`;
const codeKey = (codeHash: string): string => `code:${codeHash}`;
const ipKey = (ip: string): string => `rate:ip:${ip}`;
const ALL_KEY = 'rate:all';

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ROUTE_LENGTH) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** A P-256 public key JWK, without a private part. */
function publicJwk(value: unknown): EcPublicJwk | null {
  if (!isObject(value) || 'd' in value) return null;
  const { kty, crv, x, y } = value;
  if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string') return null;
  if (!BASE64URL_32_BYTES.test(x) || !BASE64URL_32_BYTES.test(y)) return null;
  return { kty, crv, x, y };
}

/**
 * The rendezvous Durable Object (one instance, `idFromName('registry')`): NAS public keys, pairing codes
 * by hash with their routes and expiry, and lookup rate limits. An alarm deletes expired codes and stale
 * rate-limit entries. The Worker in `index.ts` routes and adds CORS; this class answers the three POSTs.
 */
export class CodeRegistry {
  private readonly storage: RegistryStorage;

  constructor(state: RegistryState, _env?: unknown, private readonly now: () => number = Date.now) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    switch (path) {
      case '/nas':
        return this.registerNas(await readJson(request));
      case '/codes':
        return this.registerCode(await readJson(request));
      case '/codes/lookup': {
        const ip = (request.headers.get('CF-Connecting-IP') ?? 'unknown').slice(0, 64);
        if (!(await this.allowLookup(ip))) return json(429, { error: 'too many lookups' });
        return this.lookup(await readJson(request));
      }
      default:
        return json(404, { error: 'not found' });
    }
  }

  /** Deletes expired codes and stale rate-limit entries, then wakes again for the next one. */
  async alarm(): Promise<void> {
    const now = this.now();
    let next = Infinity;
    for (const [key, record] of await this.storage.list<CodeRecord>({ prefix: codeKey('') })) {
      if (record.expiresAt <= now) await this.storage.delete(key);
      else next = Math.min(next, record.expiresAt);
    }
    for (const [key, hits] of await this.storage.list<number[]>({ prefix: ipKey('') })) {
      const stale = Math.max(...hits) + MINUTE;
      if (stale <= now) await this.storage.delete(key);
      else next = Math.min(next, stale);
    }
    if (next !== Infinity) await this.storage.setAlarm(next);
  }

  /** `POST /nas { publicKeyJwk }` → `{ nasId }`; the id is the key's thumbprint, so this is idempotent. */
  private async registerNas(body: unknown): Promise<Response> {
    const jwk = isObject(body) ? publicJwk(body.publicKeyJwk) : null;
    if (!jwk) return json(400, { error: 'bad request' });
    try {
      await crypto.subtle.importKey('jwk', jwk, ECDSA_KEY, false, ['verify']);
    } catch {
      return json(400, { error: 'bad request' });
    }
    const nasId = await nasIdOf(jwk);
    if ((await this.storage.get<NasRecord>(nasKey(nasId))) === undefined) {
      await this.storage.put<NasRecord>(nasKey(nasId), { publicKeyJwk: jwk });
    }
    return json(200, { nasId });
  }

  /** `POST /codes { nasId, codeHash, routes, expiresAt, signature }` → 204, signed by the NAS's key. */
  private async registerCode(body: unknown): Promise<Response> {
    if (!isObject(body)) return json(400, { error: 'bad request' });
    const { nasId, codeHash, routes, expiresAt, signature } = body;
    if (
      typeof nasId !== 'string' ||
      !BASE64URL_32_BYTES.test(nasId) ||
      typeof codeHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(codeHash) ||
      !isObject(routes) ||
      Object.keys(routes).some((k) => k !== 'https') ||
      (routes.https !== undefined && !isHttpUrl(routes.https)) ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      typeof signature !== 'string'
    ) {
      return json(400, { error: 'bad request' });
    }
    // A signed request stays valid only until its code expires, so a captured one can't be replayed later.
    const now = this.now();
    if (expiresAt <= now || expiresAt > now + MAX_CODE_AHEAD_MS) return json(400, { error: 'bad expiry' });

    const nas = await this.storage.get<NasRecord>(nasKey(nasId));
    if (!nas) return json(401, { error: 'unknown nas' });
    const key = await crypto.subtle.importKey('jwk', nas.publicKeyJwk, ECDSA_KEY, false, ['verify']);
    const signed = { nasId, codeHash, routes: routes.https === undefined ? {} : { https: routes.https }, expiresAt };
    const sig = fromBase64url(signature);
    if (sig === null || sig.length !== 64 || !(await crypto.subtle.verify(ECDSA_SIGN, key, sig, signedMessage(signed)))) {
      return json(401, { error: 'bad signature' });
    }

    const existing = await this.storage.get<CodeRecord>(codeKey(codeHash));
    if (existing && existing.nasId !== nasId && existing.expiresAt > now) return json(409, { error: 'code taken' });
    await this.storage.put<CodeRecord>(codeKey(codeHash), { nasId, routes: signed.routes, expiresAt });
    await this.armAlarm(expiresAt);
    return new Response(null, { status: 204 });
  }

  /** `POST /codes/lookup { code }` → `{ nasId, routes }`; never anything for an unknown or expired code. */
  private async lookup(body: unknown): Promise<Response> {
    if (!isObject(body) || typeof body.code !== 'string' || body.code.length > 64) return json(400, { error: 'bad request' });
    const hash = await codeHashOf(body.code);
    const record = hash === null ? undefined : await this.storage.get<CodeRecord>(codeKey(hash));
    if (!record || record.expiresAt <= this.now()) return json(404, { error: 'unknown code' });
    const answer: CodeLookup = { nasId: record.nasId, routes: record.routes };
    return json(200, answer);
  }

  /** Sliding-window limits: 10 lookups per minute per client IP and 1,000 per hour overall. Refused tries don't count. */
  private async allowLookup(ip: string): Promise<boolean> {
    const now = this.now();
    const ipHits = ((await this.storage.get<number[]>(ipKey(ip))) ?? []).filter((t) => t > now - MINUTE);
    const allHits = ((await this.storage.get<number[]>(ALL_KEY)) ?? []).filter((t) => t > now - HOUR);
    if (ipHits.length >= LOOKUPS_PER_IP_PER_MINUTE || allHits.length >= LOOKUPS_PER_HOUR) return false;
    ipHits.push(now);
    allHits.push(now);
    await this.storage.put(ipKey(ip), ipHits);
    await this.storage.put(ALL_KEY, allHits);
    await this.armAlarm(now + MINUTE);
    return true;
  }

  private async armAlarm(time: number): Promise<void> {
    const current = await this.storage.getAlarm();
    if (current === null || current > time) await this.storage.setAlarm(time);
  }
}

/** The request's JSON body, or undefined when it is too long or not JSON. */
async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
