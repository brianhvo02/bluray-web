import { beforeEach, describe, expect, it } from 'vitest';
import { CodeRegistry } from './code-registry';
import { memoryState } from './memory-state';
import type { MemoryStorage } from './memory-state';
import { SIGNAL_MAX_MESSAGE_BYTES, base64url, signalAuthMessage, signedMessage } from './protocol';
import { Signalling } from './signalling';
import type { SignalSocket, SignallingState } from './signalling';

const MINUTE = 60_000;

/** A server-side WebSocket stand-in: records what the Durable Object sends and how it closes the socket. */
class FakeSocket implements SignalSocket {
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | undefined;
  private attachment: unknown = null;

  send(message: string): void {
    if (this.closed) throw new Error('send after close');
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closed ??= { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  /** The parsed messages sent so far. */
  messages(): Record<string, unknown>[] {
    return this.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
  }
}

/** The hibernation API in memory: accepted sockets stay listed, closed or not, until their peer's close arrives. */
class FakeState implements SignallingState {
  readonly storage: MemoryStorage = memoryState().storage;
  readonly accepted: { ws: FakeSocket; tags: string[] }[] = [];

  acceptWebSocket(ws: SignalSocket, tags: string[] = []): void {
    this.accepted.push({ ws: ws as FakeSocket, tags });
  }

  getWebSockets(tag?: string): SignalSocket[] {
    return this.accepted.filter((a) => tag === undefined || a.tags.includes(tag)).map((a) => a.ws);
  }

  remove(ws: FakeSocket): void {
    this.accepted.splice(
      this.accepted.findIndex((a) => a.ws === ws),
      1,
    );
  }
}

let clock: number;
let state: FakeState;
let registry: CodeRegistry;
let signalling: Signalling;
let keys: CryptoKeyPair;
let nasId: string;

beforeEach(async () => {
  clock = 1_800_000_000_000;
  registry = new CodeRegistry(memoryState(), undefined, () => clock);
  state = new FakeState();
  const env = { CODE_REGISTRY: { idFromName: (name: string) => ({ name }), get: () => ({ fetch: (r: Request) => registry.fetch(r) }) } };
  signalling = new Signalling(state, env, {
    now: () => clock,
    upgrade: () => ({ server: new FakeSocket(), response: new Response(null, { status: 200, headers: { 'X-Upgraded': '1' } }) }),
  });
  keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  nasId = await registerNas(keys);
});

async function registerNas(pair: CryptoKeyPair): Promise<string> {
  const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const res = await registry.fetch(new Request('https://rendezvous.example/nas', { method: 'POST', body: JSON.stringify({ publicKeyJwk: { kty, crv, x, y } }) }));
  return ((await res.json()) as { nasId: string }).nasId;
}

async function sign(pair: CryptoKeyPair, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)));
}

/** Opens a socket on `/signal/<role>`; the socket is undefined when the upgrade was refused. */
async function open(role: 'nas' | 'device', id = nasId): Promise<{ res: Response; ws: FakeSocket | undefined }> {
  const before = state.accepted.length;
  const res = await signalling.fetch(new Request(`https://rendezvous.example/signal/${role}?nasId=${id}`, { headers: { Upgrade: 'websocket' } }));
  return { res, ws: state.accepted[before]?.ws };
}

async function nasSocket(pair = keys): Promise<FakeSocket> {
  const { ws } = await open('nas');
  const challenge = ws!.messages()[0]!;
  expect(challenge.t).toBe('challenge');
  expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const signature = await sign(pair, signalAuthMessage({ nasId, nonce: challenge.nonce as string }));
  await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'auth', signature }));
  return ws!;
}

async function deviceSocket(): Promise<FakeSocket> {
  const { res, ws } = await open('device');
  expect(res.headers.get('X-Upgraded')).toBe('1');
  return ws!;
}

/** The peer's close frame arrives: the runtime calls the handler, then forgets the socket. */
async function peerCloses(ws: FakeSocket): Promise<void> {
  await signalling.webSocketClose(ws, 1000, '', true);
  state.remove(ws);
}

describe('NAS socket', () => {
  it('authenticates with a signature over the challenge', async () => {
    const nas = await nasSocket();
    expect(nas.closed).toBeUndefined();
    const device = await deviceSocket();
    expect(device.closed).toBeUndefined();
  });

  it('closes on a bad signature', async () => {
    const nas = await nasSocket(await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair);
    expect(nas.closed).toEqual({ code: 1008, reason: 'bad-auth' });
    expect((await deviceSocket()).closed).toEqual({ code: 4404, reason: 'nas-offline' });
  });

  it('closes on a code-registration signature replayed as auth', async () => {
    const { ws } = await open('nas');
    const registration = { nasId, codeHash: '0'.repeat(64), routes: {}, expiresAt: clock + 10 * MINUTE };
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'auth', signature: await sign(keys, signedMessage(registration)) }));
    expect(ws!.closed).toEqual({ code: 1008, reason: 'bad-auth' });
  });

  it('closes on a signature over another challenge', async () => {
    const { ws } = await open('nas');
    const signature = await sign(keys, signalAuthMessage({ nasId, nonce: 'A'.repeat(43) }));
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'auth', signature }));
    expect(ws!.closed).toEqual({ code: 1008, reason: 'bad-auth' });
  });

  it('closes on a NAS id the registry does not know', async () => {
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const { ws } = await open('nas', 'B'.repeat(43));
    const nonce = ws!.messages()[0]!.nonce as string;
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'auth', signature: await sign(other, signalAuthMessage({ nasId: 'B'.repeat(43), nonce })) }));
    expect(ws!.closed).toEqual({ code: 1008, reason: 'bad-auth' });
  });

  it('closes on anything but auth before it authenticates', async () => {
    const { ws } = await open('nas');
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'answer', sid: 'x' }));
    expect(ws!.closed).toEqual({ code: 1008, reason: 'bad-message' });
  });

  it('closes a socket that has not authenticated within 10 s', async () => {
    const { ws } = await open('nas');
    expect(state.storage.alarm).toBe(clock + 10_000);
    clock += 10_000;
    state.storage.alarm = null;
    await signalling.alarm();
    expect(ws!.closed).toEqual({ code: 1008, reason: 'auth-timeout' });
  });

  it('replaces the old NAS socket with a new one, and devices stay', async () => {
    const first = await nasSocket();
    const device = await deviceSocket();
    const second = await nasSocket();
    expect(first.closed).toEqual({ code: 4409, reason: 'replaced' });
    await peerCloses(first);
    expect(device.closed).toBeUndefined();
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'offer', sdp: 'v=0' }));
    expect(second.messages().at(-1)).toMatchObject({ t: 'offer', sdp: 'v=0' });
    expect(first.messages().filter((m) => m.t === 'offer')).toEqual([]);
  });

  it('closes the devices with 4404 when the NAS socket goes', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    await peerCloses(nas);
    expect(device.closed).toEqual({ code: 4404, reason: 'nas-offline' });
  });
});

describe('device socket', () => {
  it('is closed with 4404 nas-offline while no NAS socket is live', async () => {
    expect((await deviceSocket()).closed).toEqual({ code: 4404, reason: 'nas-offline' });
    await open('nas');
    // A NAS socket that hasn't authenticated doesn't count.
    expect((await deviceSocket()).closed).toEqual({ code: 4404, reason: 'nas-offline' });
  });

  it('forwards an offer to the NAS with the sid, and the answer back to that device without it', async () => {
    const nas = await nasSocket();
    const a = await deviceSocket();
    const b = await deviceSocket();
    await signalling.webSocketMessage(a, JSON.stringify({ t: 'offer', sdp: 'v=0 a', sid: 'forged' }));
    await signalling.webSocketMessage(b, JSON.stringify({ t: 'offer', sdp: 'v=0 b' }));
    const [offerA, offerB] = nas.messages().slice(-2);
    expect(offerA).toMatchObject({ t: 'offer', sdp: 'v=0 a' });
    expect(offerA!.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(offerA!.sid).not.toBe('forged');
    expect(offerB!.sid).not.toBe(offerA!.sid);

    await signalling.webSocketMessage(nas, JSON.stringify({ t: 'answer', sid: offerA!.sid, sdp: 'v=0 answer' }));
    await signalling.webSocketMessage(nas, JSON.stringify({ t: 'candidate', sid: offerB!.sid, candidate: 'c' }));
    expect(a.messages()).toEqual([{ t: 'answer', sdp: 'v=0 answer' }]);
    expect(b.messages()).toEqual([{ t: 'candidate', candidate: 'c' }]);
  });

  it('forwards candidates and TURN requests both ways', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'candidate', candidate: 'c' }));
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'turn-request', deviceId: 'd' }));
    const sid = nas.messages().at(-1)!.sid;
    expect(nas.messages().slice(-2).map((m) => m.t)).toEqual(['candidate', 'turn-request']);
    await signalling.webSocketMessage(nas, JSON.stringify({ t: 'turn-response', sid, iceServers: [] }));
    expect(device.messages()).toEqual([{ t: 'turn-response', iceServers: [] }]);
  });

  it('closes a device that sends an unknown type, non-JSON or binary', async () => {
    const nas = await nasSocket();
    for (const message of [JSON.stringify({ t: 'answer', sdp: 'x' }), JSON.stringify({ t: 'auth' }), '{', '[]', new ArrayBuffer(4)]) {
      const device = await deviceSocket();
      await signalling.webSocketMessage(device, message);
      expect(device.closed).toEqual({ code: 1008, reason: 'bad-message' });
    }
    expect(nas.messages().map((m) => m.t)).toEqual(['challenge']);
  });

  it('rejects a message of 16 KB + 1 and forwards one of 16 KB', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    const frame = (size: number): string => {
      const head = JSON.stringify({ t: 'offer', sdp: '' });
      return JSON.stringify({ t: 'offer', sdp: 'x'.repeat(size - head.length) });
    };
    expect(new TextEncoder().encode(frame(SIGNAL_MAX_MESSAGE_BYTES)).byteLength).toBe(16_384);
    await signalling.webSocketMessage(device, frame(SIGNAL_MAX_MESSAGE_BYTES));
    expect(device.closed).toBeUndefined();
    expect(nas.messages().at(-1)!.t).toBe('offer');
    await signalling.webSocketMessage(device, frame(SIGNAL_MAX_MESSAGE_BYTES + 1));
    expect(device.closed).toEqual({ code: 1009, reason: 'too-big' });
    expect(nas.messages().filter((m) => m.t === 'offer')).toHaveLength(1);
  });

  it('drops what the NAS sends of an unknown type, too big, to an unknown sid or without one', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'offer', sdp: 'v=0' }));
    const sid = nas.messages().at(-1)!.sid as string;
    for (const message of [
      JSON.stringify({ t: 'offer', sid }),
      JSON.stringify({ t: 'answer' }),
      JSON.stringify({ t: 'answer', sid: 'nobody' }),
      JSON.stringify({ t: 'answer', sid, sdp: 'x'.repeat(SIGNAL_MAX_MESSAGE_BYTES) }),
      '{',
      new ArrayBuffer(4),
    ]) {
      await signalling.webSocketMessage(nas, message);
    }
    expect(nas.closed).toBeUndefined();
    expect(device.sent).toEqual([]);
  });

  it('allows 100 device connection attempts per minute per NAS; the NAS itself still connects', async () => {
    await nasSocket();
    for (let i = 0; i < 100; i++) expect((await open('device')).res.status).toBe(200);
    const limited = await open('device');
    expect(limited.res.status).toBe(429);
    expect(limited.ws).toBeUndefined();
    expect((await nasSocket()).closed).toBeUndefined();
    clock += MINUTE;
    expect((await open('device')).res.status).toBe(200);
  });

  it('deletes the stale attempt log in the alarm', async () => {
    await open('device');
    expect(state.storage.data.size).toBe(1);
    clock += MINUTE;
    state.storage.alarm = null;
    await signalling.alarm();
    expect(state.storage.data.size).toBe(0);
    expect(state.storage.alarm).toBeNull();
  });

  it('refuses requests that are not WebSocket upgrades, or for another path', async () => {
    expect((await signalling.fetch(new Request(`https://rendezvous.example/signal/device?nasId=${nasId}`))).status).toBe(426);
    expect((await signalling.fetch(new Request(`https://rendezvous.example/elsewhere?nasId=${nasId}`, { headers: { Upgrade: 'websocket' } }))).status).toBe(404);
    expect((await signalling.fetch(new Request('https://rendezvous.example/signal/device?nasId=x', { headers: { Upgrade: 'websocket' } }))).status).toBe(400);
  });
});
