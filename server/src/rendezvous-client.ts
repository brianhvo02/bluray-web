import type { webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ECDSA_KEY, ECDSA_SIGN, base64url, nasIdOf, signedMessage, unregisterMessage } from '../../rendezvous/src/protocol';
import type { EcPublicJwk } from '../../src/engine/disc/nas-api';
import type { CodeRegistrar } from './codes';
import { createOnce } from './store';

const TIMEOUT_MS = 10_000;

interface NasKey {
  privateKey: webcrypto.CryptoKey;
  publicKeyJwk: EcPublicJwk;
}

/**
 * Registers this NAS's pairing codes with the rendezvous Worker, so a device can find the NAS from a code alone.
 * The NAS's P-256 key lives in `keyFile` (mode 600, made once); the NAS registers its public key once per
 * process, then signs each code registration with the private key.
 */
export class RendezvousClient implements CodeRegistrar {
  private readonly base: string;
  private key: Promise<NasKey> | undefined;
  private nasId: Promise<string> | undefined;

  constructor(
    base: string,
    private readonly keyFile: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = base.endsWith('/') ? base : `${base}/`;
  }

  /** This NAS's id with the service, registering its public key on the first call. */
  ensureRegistered(): Promise<string> {
    this.nasId ??= this.register().catch((err: unknown) => {
      this.nasId = undefined;
      throw err;
    });
    return this.nasId;
  }

  async registerCode(codeHash: string, routes: { https: string }, expiresAt: number): Promise<void> {
    let status = await this.postCode(await this.ensureRegistered(), codeHash, routes, expiresAt);
    if (status === 401) {
      // The service may have lost its registry (a new deployment): register the key again, once.
      this.nasId = undefined;
      status = await this.postCode(await this.ensureRegistered(), codeHash, routes, expiresAt);
    }
    if (status !== 204) throw new Error(`rendezvous POST /codes answered ${status}`);
  }

  /** Signs and sends `DELETE /codes`; the service answers 204 whether or not it still held the code. */
  async unregisterCode(codeHash: string): Promise<void> {
    const nasId = await this.ensureRegistered();
    const { privateKey } = await this.loadKey();
    const signature = await crypto.subtle.sign(ECDSA_SIGN, privateKey, unregisterMessage({ nasId, codeHash }));
    const res = await this.send('DELETE', 'codes', { nasId, codeHash, signature: base64url(new Uint8Array(signature)) });
    await res.body?.cancel();
    if (res.status !== 204) throw new Error(`rendezvous DELETE /codes answered ${res.status}`);
  }

  private async register(): Promise<string> {
    const { publicKeyJwk } = await this.loadKey();
    const res = await this.post('nas', { publicKeyJwk });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`rendezvous POST /nas answered ${res.status}`);
    }
    const { nasId } = (await res.json()) as { nasId?: unknown };
    const expected = await nasIdOf(publicKeyJwk);
    if (nasId !== expected) throw new Error('rendezvous POST /nas answered an unexpected id');
    return expected;
  }

  private async postCode(nasId: string, codeHash: string, routes: { https: string }, expiresAt: number): Promise<number> {
    const { privateKey } = await this.loadKey();
    const fields = { nasId, codeHash, routes: { https: routes.https }, expiresAt };
    const signature = await crypto.subtle.sign(ECDSA_SIGN, privateKey, signedMessage(fields));
    const res = await this.post('codes', { ...fields, signature: base64url(new Uint8Array(signature)) });
    await res.body?.cancel();
    return res.status;
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.send('POST', path, body);
  }

  private send(method: 'POST' | 'DELETE', path: string, body: unknown): Promise<Response> {
    return this.fetchFn(new URL(path, this.base), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private loadKey(): Promise<NasKey> {
    this.key ??= this.readOrCreateKey().catch((err: unknown) => {
      this.key = undefined;
      throw err;
    });
    return this.key;
  }

  /** Reads the key file, first making a new key when there is none (another process's new key wins a race). */
  private async readOrCreateKey(): Promise<NasKey> {
    let text = this.readKeyFile();
    if (text === null) {
      const pair = (await crypto.subtle.generateKey(ECDSA_KEY, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
      const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      mkdirSync(dirname(this.keyFile), { recursive: true });
      createOnce(this.keyFile, JSON.stringify({ privateKeyJwk }));
      text = this.readKeyFile()!;
    }
    let jwk: webcrypto.JsonWebKey | undefined;
    try {
      jwk = (JSON.parse(text) as { privateKeyJwk?: webcrypto.JsonWebKey }).privateKeyJwk;
    } catch {
      jwk = undefined;
    }
    const { kty, crv, x, y, d } = jwk ?? {};
    if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string' || typeof d !== 'string') {
      throw new Error(`${this.keyFile} is corrupt: not a P-256 private key`);
    }
    const privateKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, ECDSA_KEY, false, ['sign']);
    return { privateKey, publicKeyJwk: { kty, crv, x, y } };
  }

  private readKeyFile(): string | null {
    try {
      return readFileSync(this.keyFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
