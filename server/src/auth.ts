import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import { codeHash, newCode, normalizeCode } from './codes';
import type { Store } from './store';

type JsonWebKey = webcrypto.JsonWebKey;

export interface Device {
  readonly id: string;
  readonly name: string;
  readonly owner: boolean;
  readonly publicKeyJwk: JsonWebKey;
  readonly pairedAt: number;
  lastSeen: number;
}

export interface PairingCode {
  readonly id: string;
  /** codeHash() of the code; the code itself is never stored. */
  readonly hash: string;
  readonly owner: boolean;
  readonly expiresAt: number;
}

const CODE_TTL_MS = 10 * 60_000;
const CHALLENGE_TTL_MS = 60_000;
const MAX_CHALLENGES_PER_DEVICE = 5;
const SESSION_TTL_MS = 60 * 60_000;
/** WebCrypto's ECDSA P-256 signature: r || s, 32 bytes each (IEEE P1363). */
const SIGNATURE_BYTES = 64;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const randomId = (): string => randomBytes(16).toString('base64url');

/** The public P-256 key as `{kty, crv, x, y}`, or null for anything else (private keys included). */
export function p256PublicJwk(jwk: unknown): JsonWebKey | null {
  if (typeof jwk !== 'object' || jwk === null || 'd' in jwk) return null;
  const { kty, crv, x, y } = jwk as Record<string, unknown>;
  if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string') return null;
  if (!BASE64URL.test(x) || !BASE64URL.test(y)) return null;
  const key = { kty, crv, x, y };
  try {
    createPublicKey({ key, format: 'jwk' });
  } catch {
    return null;
  }
  return key;
}

/**
 * Pairing codes, paired devices and session tokens.
 * A token is `base64url(deviceId.expiresAt).base64url(HMAC-SHA256(secret, first part))`.
 */
export class Auth {
  /** Outstanding challenges → their device; single use, in memory only. */
  private readonly challenges = new Map<string, { deviceId: string; expiresAt: number }>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number,
  ) {
    store.secret();
  }

  /** A single-use code valid 10 minutes; only its hash is kept. */
  createCode(opts: { owner: boolean }): { record: PairingCode; code: string } {
    const code = newCode((n) => randomBytes(n));
    const record: PairingCode = { id: randomId(), hash: codeHash(code), owner: opts.owner, expiresAt: this.now() + CODE_TTL_MS };
    this.store.update((data) => {
      data.codes = [...this.live(data.codes), record];
    });
    return { record, code };
  }

  /** Spends the code and pairs the device, or null for an unknown, used or expired code or an unusable key. */
  redeem(code: string, deviceName: string, publicKeyJwk: JsonWebKey): Device | null {
    const normalized = normalizeCode(code);
    const key = p256PublicJwk(publicKeyJwk);
    if (normalized === null || key === null) return null;
    const hash = codeHash(normalized);
    // Failed guesses don't touch the disk.
    if (!this.live(this.store.read().codes).some((c) => c.hash === hash)) return null;
    return this.store.update((data) => {
      const codes = this.live(data.codes);
      const found = codes.find((c) => c.hash === hash);
      data.codes = codes.filter((c) => c !== found);
      if (!found) return null;
      const now = this.now();
      const device: Device = { id: randomId(), name: deviceName.trim(), owner: found.owner, publicKeyJwk: key, pairedAt: now, lastSeen: now };
      data.devices.push(device);
      return device;
    });
  }

  /** A random challenge for the device to sign, valid 60 s; null for an unknown device. A device holds at most 5, the oldest dropped. */
  challenge(deviceId: string): string | null {
    if (!this.device(deviceId)) return null;
    const now = this.now();
    for (const [c, entry] of this.challenges) if (entry.expiresAt <= now) this.challenges.delete(c);
    // The map keeps insertion order, so the first ones found are the oldest.
    const mine = [...this.challenges].filter(([, entry]) => entry.deviceId === deviceId);
    for (const [c] of mine.slice(0, Math.max(0, mine.length - MAX_CHALLENGES_PER_DEVICE + 1))) this.challenges.delete(c);
    const challenge = randomBytes(32).toString('base64url');
    this.challenges.set(challenge, { deviceId, expiresAt: now + CHALLENGE_TTL_MS });
    return challenge;
  }

  /**
   * A session token valid 1 hour for a device that signed `challenge` (its UTF-8 bytes) with ECDSA P-256 SHA-256;
   * `signatureB64` is base64url of the raw r || s. Each challenge is spent by the first attempt.
   */
  startSession(deviceId: string, challenge: string, signatureB64: string): { token: string; expiresAt: number } | null {
    const entry = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!entry || entry.deviceId !== deviceId || this.now() >= entry.expiresAt) return null;
    const device = this.device(deviceId);
    if (!device || !BASE64URL.test(signatureB64)) return null;
    const signature = Buffer.from(signatureB64, 'base64url');
    if (signature.length !== SIGNATURE_BYTES) return null;
    let ok = false;
    try {
      const key = createPublicKey({ key: device.publicKeyJwk, format: 'jwk' });
      ok = verifySignature('sha256', Buffer.from(challenge, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature);
    } catch {
      ok = false;
    }
    if (!ok) return null;
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.store.update((data) => {
      const stored = data.devices.find((d) => d.id === deviceId);
      if (stored) stored.lastSeen = now;
    });
    const payload = Buffer.from(`${deviceId}.${expiresAt}`, 'utf8').toString('base64url');
    return { token: `${payload}.${this.mac(payload)}`, expiresAt };
  }

  /** The token's device, or null when the token is malformed, forged, expired or its device revoked. */
  verify(token: string): Device | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, mac] = parts as [string, string];
    const given = Buffer.from(mac, 'utf8');
    const expected = Buffer.from(this.mac(payload), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const text = Buffer.from(payload, 'base64url').toString('utf8');
    const dot = text.lastIndexOf('.');
    const expiresAt = Number(text.slice(dot + 1));
    if (dot <= 0 || !Number.isSafeInteger(expiresAt) || this.now() >= expiresAt) return null;
    return this.device(text.slice(0, dot));
  }

  revokeDevice(id: string): void {
    this.store.update((data) => {
      data.devices = data.devices.filter((d) => d.id !== id);
    });
    for (const [c, entry] of this.challenges) if (entry.deviceId === id) this.challenges.delete(c);
  }

  deleteCode(id: string): void {
    this.store.update((data) => {
      data.codes = this.live(data.codes).filter((c) => c.id !== id);
    });
  }

  devices(): Device[] {
    return this.store.read().devices.map((d) => ({ ...d }));
  }

  /** Codes not yet used or expired. */
  codes(): PairingCode[] {
    return this.live(this.store.read().codes);
  }

  private device(id: string): Device | null {
    const found = this.store.read().devices.find((d) => d.id === id);
    return found ? { ...found } : null;
  }

  private live(codes: readonly PairingCode[]): PairingCode[] {
    const now = this.now();
    return codes.filter((c) => now < c.expiresAt);
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.store.secret()).update(payload).digest('base64url');
  }
}
