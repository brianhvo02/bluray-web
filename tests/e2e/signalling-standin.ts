/// <reference types="node" />
/**
 * The rendezvous Worker's signalling for nas-server.ts: the real `Signalling` Durable Object class, one per NAS id, run
 * in Node over a small server-side WebSocket (RFC 6455: the handshake, text frames, ping and close) in place of the
 * Workers runtime's hibernatable sockets, with its storage and alarm in memory. Test-only: no extensions, no
 * subprotocols, and messages up to 1 MB.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { MemoryStorage } from '../../rendezvous/src/memory-state';
import { Signalling, type SignalSocket, type SignallingEnv, type SignallingState, type Upgrade } from '../../rendezvous/src/signalling';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** The header a stand-in upgrade's response carries in place of the runtime's 101 (which `Response` can't hold). */
const UPGRADE_HEADER = 'x-standin-upgrade';

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** The server end of one WebSocket, as `SignalSocket`; what it sends before the handshake is written after it. */
class NodeSignalSocket implements SignalSocket {
  onMessage: ((message: string | ArrayBuffer) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  private socket: Duplex | null = null;
  private readonly early: Buffer[] = [];
  private attachment: unknown = null;
  private closeSent = false;
  private closed = false;
  private buffered = Buffer.alloc(0);
  private fragments: { opcode: number; parts: Buffer[] } | null = null;

  send(message: string): void {
    if (this.closeSent) throw new Error('the socket is closing');
    this.write(frame(0x1, Buffer.from(message, 'utf8')));
  }

  close(code = 1000, reason = ''): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.write(frame(0x8, payload));
    // the peer answers with its own close frame; one that never does is cut off
    setTimeout(() => this.socket?.destroy(), 2_000).unref();
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  /** Takes over `socket` once the handshake is written. */
  bind(socket: Duplex, head: Buffer): void {
    this.socket = socket;
    for (const b of this.early.splice(0)) socket.write(b);
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.ended(1006, ''));
    socket.on('error', () => socket.destroy());
    if (this.closeSent) setTimeout(() => socket.destroy(), 2_000).unref(); // closed before the handshake was out
    if (head.length > 0) this.receive(head);
  }

  private write(b: Buffer): void {
    if (this.socket) this.socket.write(b);
    else this.early.push(b);
  }

  private ended(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.onClose?.(code, reason);
  }

  private receive(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    for (;;) {
      const b = this.buffered;
      if (b.length < 2) return;
      const fin = (b[0]! & 0x80) !== 0;
      const opcode = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        at = 10;
      }
      if (len > MAX_MESSAGE_BYTES) return this.close(1009, 'too big');
      const mask = masked ? b.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (b.length < at + len) return;
      const payload = Buffer.from(b.subarray(at, at + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.buffered = b.subarray(at + len);
      this.frameIn(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  private frameIn(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragments) return this.close(1002, 'unexpected continuation');
        this.fragments.parts.push(payload);
        if (fin) {
          const { opcode: first, parts } = this.fragments;
          this.fragments = null;
          this.deliver(first, Buffer.concat(parts));
        }
        return;
      case 0x1:
      case 0x2:
        if (fin) this.deliver(opcode, payload);
        else this.fragments = { opcode, parts: [payload] };
        return;
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent) {
          this.closeSent = true;
          this.write(frame(0x8, code === 1005 ? Buffer.alloc(0) : payload.subarray(0, 2)));
        }
        this.socket?.end();
        this.ended(code, reason);
        return;
      }
      case 0x9:
        if (!this.closeSent) this.write(frame(0xa, payload));
        return;
      default:
        return; // pong
    }
  }

  private deliver(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    const data = opcode === 0x1 ? payload.toString('utf8') : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    this.onMessage?.(data as string | ArrayBuffer);
  }
}

/** The hibernation API over Node sockets: accepted sockets stay listed until their close is handled. */
class StandInState implements SignallingState {
  readonly storage: MemoryStorage;
  private readonly accepted: Array<{ ws: SignalSocket; tags: string[] }> = [];
  object: Signalling | null = null;

  constructor() {
    const state = this;
    let timer: NodeJS.Timeout | undefined;
    this.storage = new (class extends MemoryStorage {
      override async setAlarm(time: number): Promise<void> {
        await super.setAlarm(time);
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.alarm = null;
          void state.object?.alarm();
        }, Math.max(0, time - Date.now()));
        timer.unref();
      }
    })();
  }

  acceptWebSocket(ws: SignalSocket, tags: string[] = []): void {
    this.accepted.push({ ws, tags });
    const socket = ws as NodeSignalSocket;
    socket.onMessage = (message) => void this.object?.webSocketMessage(ws, message);
    socket.onClose = (code, reason) => {
      void this.object?.webSocketClose(ws, code, reason, code !== 1006).finally(() => {
        const at = this.accepted.findIndex((a) => a.ws === ws);
        if (at >= 0) this.accepted.splice(at, 1);
      });
    };
  }

  getWebSockets(tag?: string): SignalSocket[] {
    return this.accepted.filter((a) => tag === undefined || a.tags.includes(tag)).map((a) => a.ws);
  }
}

/** Sockets made by upgrades whose response hasn't reached the HTTP side yet. */
const upgrading = new Map<string, NodeSignalSocket>();
let nextUpgrade = 0;

function standInUpgrade(): Upgrade {
  const id = String(++nextUpgrade);
  const server = new NodeSignalSocket();
  upgrading.set(id, server);
  return { server, response: new Response(null, { status: 200, headers: { [UPGRADE_HEADER]: id } }) };
}

/** The `SIGNALLING` namespace: one `Signalling` object per NAS id, as `idFromName(nasId)` gives on Cloudflare. */
export function signallingNamespace(env: SignallingEnv): { idFromName(name: string): object; get(id: object): { fetch(r: Request): Promise<Response> } } {
  const objects = new Map<string, Signalling>();
  return {
    idFromName: (name) => ({ name }),
    get: (id) => {
      const name = (id as { name: string }).name;
      let object = objects.get(name);
      if (!object) {
        const state = new StandInState();
        object = new Signalling(state, env, { upgrade: standInUpgrade });
        state.object = object;
        objects.set(name, object);
      }
      const o = object;
      return { fetch: (r) => o.fetch(r) };
    },
  };
}

/**
 * Answers an HTTP upgrade with what the Worker made of it (`answer`): a stand-in upgrade becomes the 101 handshake
 * and its socket takes the connection; anything else (429, 400, …) is written out as it is and the connection closed.
 */
export async function completeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, answer: Response): Promise<void> {
  const id = answer.headers.get(UPGRADE_HEADER);
  const ws = id === null ? undefined : upgrading.get(id);
  if (id !== null) upgrading.delete(id);
  const key = req.headers['sec-websocket-key'];
  if (!ws || typeof key !== 'string') {
    const body = Buffer.from(await answer.arrayBuffer());
    socket.end(`HTTP/1.1 ${answer.status} ${answer.statusText || 'Error'}\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body.toString('utf8')}`);
    return;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  ws.bind(socket, head);
}
