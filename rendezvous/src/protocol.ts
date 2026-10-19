/**
 * The rendezvous protocol's shared pieces, used by the Worker and by the NAS's client
 * (`server/src/rendezvous-client.ts`). WebCrypto only, so both runtimes run the same code.
 */
import { normalizeCode } from '../../src/engine/disc/pairing-code';
import type { CodeRegistration, EcPublicJwk } from '../../src/engine/disc/nas-api';

export const ECDSA_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
export const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** A code's `expiresAt` may be at most this far ahead; invites live 3 days, the hour absorbs clock skew. */
export const MAX_CODE_AHEAD_MS = 3 * 24 * 60 * 60_000 + 60 * 60_000;

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Hex SHA-256 of the normalized code (the same value as the server's `codeHash`); null for a string that isn't a code. */
export async function codeHashOf(code: string): Promise<string | null> {
  const normalized = normalizeCode(code);
  if (normalized === null) return null;
  return Array.from(await sha256(normalized), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The NAS id: the key's RFC 7638 JWK thumbprint, so registering the same key twice gives the same id. */
export async function nasIdOf(jwk: EcPublicJwk): Promise<string> {
  return base64url(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

/**
 * The bytes a NAS signs for `DELETE /codes`. The leading type tag (which the `POST /codes` message lacks) keeps a
 * registration's signature from verifying as an unregistration, and the reverse.
 */
export function unregisterMessage(fields: { nasId: string; codeHash: string }): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ type: 'unregister-code', codeHash: fields.codeHash, nasId: fields.nasId })));
}

/** The bytes a NAS signs for `POST /codes`: every field but `signature`, in a fixed order. */
export function signedMessage(fields: Omit<CodeRegistration, 'signature'>): Uint8Array<ArrayBuffer> {
  const routes = fields.routes.https === undefined ? {} : { https: fields.routes.https };
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ codeHash: fields.codeHash, expiresAt: fields.expiresAt, nasId: fields.nasId, routes })));
}

/** A NAS id: base64url of a SHA-256 (`nasIdOf`). */
export function isNasId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/*
 * WebRTC signalling: `GET /signal/nas?nasId=` (the NAS's socket) and `GET /signal/device?nasId=` (a device's),
 * both WebSocket upgrades to the NAS's `Signalling` Durable Object. Messages are JSON text with a type field `t`.
 */

/** The largest signalling message, in UTF-8 bytes; a device that sends more is closed, a NAS's is dropped. */
export const SIGNAL_MAX_MESSAGE_BYTES = 16 * 1024;

/** The close codes and reasons the Worker uses on signalling sockets. */
export const SIGNAL_CLOSE = {
  /** A device socket while no authenticated NAS socket is live, or once the NAS's socket goes. */
  nasOffline: { code: 4404, reason: 'nas-offline' },
  /** A NAS socket another authenticated NAS socket replaced. */
  replaced: { code: 4409, reason: 'replaced' },
  /** A device message of an unknown type, not JSON, or binary; a NAS message before auth that isn't `auth`. */
  badMessage: { code: 1008, reason: 'bad-message' },
  tooBig: { code: 1009, reason: 'too-big' },
  badAuth: { code: 1008, reason: 'bad-auth' },
  authTimeout: { code: 1008, reason: 'auth-timeout' },
} as const;

/** The types a device may send; the Worker forwards them to the NAS with the device's `sid` added. */
export const DEVICE_SIGNAL_TYPES = ['offer', 'candidate', 'turn-request'] as const;
/** The types a NAS may send once authenticated; the Worker forwards them to the device `sid` names, without `sid`. */
export const NAS_SIGNAL_TYPES = ['answer', 'candidate', 'turn-response'] as const;
export type DeviceSignalType = (typeof DEVICE_SIGNAL_TYPES)[number];
export type NasSignalType = (typeof NAS_SIGNAL_TYPES)[number];

/** Worker → NAS, first on a NAS socket. */
export interface SignalChallenge {
  readonly t: 'challenge';
  readonly nonce: string;
}

/** NAS → Worker: the base64url P-256 signature over `signalAuthMessage({ nasId, nonce })`. */
export interface SignalAuth {
  readonly t: 'auth';
  readonly signature: string;
}

/** Device → Worker. */
export interface DeviceSignal {
  readonly t: DeviceSignalType;
  readonly [field: string]: unknown;
}

/** Worker → NAS: a device's message with the device socket's id. */
export interface DeviceSignalForNas extends DeviceSignal {
  readonly sid: string;
}

/** NAS → Worker, addressed to a device socket by `sid`. */
export interface NasSignal {
  readonly t: NasSignalType;
  readonly sid: string;
  readonly [field: string]: unknown;
}

/** Worker → device: a NAS's message without `sid`. */
export interface NasSignalForDevice {
  readonly t: NasSignalType;
  readonly [field: string]: unknown;
}

/**
 * The bytes a NAS signs to authenticate its signalling socket. The type tag keeps a code registration's or an
 * unregistration's signature from verifying here, and the reverse.
 */
export function signalAuthMessage(fields: { nasId: string; nonce: string }): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ type: 'signal-nas', nasId: fields.nasId, nonce: fields.nonce })));
}
