import type { webcrypto } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { p256PublicJwk } from '../auth';
import type { Auth } from '../auth';
import { HttpError, json, readJson } from '../http';
import type { Handler } from '../http';

type JsonWebKey = webcrypto.JsonWebKey;

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const MAX_DEVICE_NAME = 100;

/** Counts failures per key over a sliding window. */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly now: () => number,
    private readonly limit = MAX_FAILURES,
    private readonly windowMs = FAILURE_WINDOW_MS,
  ) {}

  blocked(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  fail(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.failures.set(key, recent);
    if (this.failures.size > 10_000) {
      for (const k of [...this.failures.keys()]) if (this.recent(k).length === 0) this.failures.delete(k);
    }
  }

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (recent.length === 0) this.failures.delete(key);
    else this.failures.set(key, recent);
    return recent;
  }
}

/** RFC 1918 and unique-local addresses: Docker networks such as Caddy's `caddy_default`. */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^f[cd][0-9a-f]{2}:/i.test(address);
}

/** The client's address: the first `X-Forwarded-For` entry when the peer is the trusted proxy, else the peer. */
export function clientAddress(req: IncomingMessage, trustProxy: (address: string) => boolean): string {
  const peer = req.socket.remoteAddress ?? '';
  if (!trustProxy(peer)) return peer;
  const first = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim();
  return first || peer;
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') throw new HttpError(400, 'bad request');
  return value;
}

async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJson(req);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad request');
  return body as Record<string, unknown>;
}

const unauthorized = () => json(401, { error: 'unauthorized' });

/** `POST /api/pair/redeem`, `POST /api/session/challenge` and `POST /api/session`: the only routes open to unpaired devices. */
export function pairRoutes(auth: Auth, opts: { now: () => number; trustProxy: (address: string) => boolean }): Handler {
  const limiter = new FailureLimiter(opts.now);
  return async (req, url) => {
    if (req.method !== 'POST') return null;
    switch (url.pathname) {
      case '/api/pair/redeem': {
        const client = clientAddress(req, opts.trustProxy);
        if (limiter.blocked(client)) return json(429, { error: 'too many tries' }, { 'Retry-After': String(FAILURE_WINDOW_MS / 1000) });
        const body = await readObject(req);
        const code = str(body, 'code');
        const deviceName = str(body, 'deviceName').trim();
        if (deviceName === '' || deviceName.length > MAX_DEVICE_NAME || !p256PublicJwk(body.publicKeyJwk)) {
          throw new HttpError(400, 'bad request');
        }
        const device = auth.redeem(code, deviceName, body.publicKeyJwk as JsonWebKey);
        if (!device) {
          limiter.fail(client);
          return json(401, { error: 'invalid code' });
        }
        return json(200, { deviceId: device.id, owner: device.owner });
      }
      case '/api/session/challenge': {
        const challenge = auth.challenge(str(await readObject(req), 'deviceId'));
        return challenge ? json(200, { challenge }) : unauthorized();
      }
      case '/api/session': {
        const body = await readObject(req);
        const session = auth.startSession(str(body, 'deviceId'), str(body, 'challenge'), str(body, 'signature'));
        return session ? json(200, session) : unauthorized();
      }
      default:
        return null;
    }
  };
}
