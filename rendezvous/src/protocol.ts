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
