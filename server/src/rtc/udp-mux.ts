import { AsyncLocalStorage } from 'node:async_hooks';
import { createSocket } from 'node:dgram';
import type { RemoteInfo, Socket } from 'node:dgram';
import { UdpTransport } from 'werift';

/**
 * Every peer connection's ICE on one UDP port. werift binds a socket per connection and refuses a port already
 * bound, so with ICE confined to one port (47998) only one connection could exist at a time. The mux owns the one
 * socket and hands each connection's ICE a virtual transport on it, routing datagrams as libdatachannel and pion do:
 * a STUN request by the connection's ufrag in its USERNAME, a STUN response by the transaction id the request went
 * out with, and anything else (DTLS, SCTP) by the remote address the transport talks to.
 *
 * werift creates its sockets through `UdpTransport.init`; `installMux` wraps it once, so a transport made while a
 * connection runs inside `MuxOwner.run` comes from that owner's mux. Anything else gets werift's own socket.
 */

type Address = [string, number];

const STUN_MAGIC = 0x2112a442;
const STUN_USERNAME = 0x0006;
/** A STUN transaction's route is forgotten after this (werift's checks give up well before). */
const TRANSACTION_MS = 60_000;

const owners = new AsyncLocalStorage<MuxOwner>();
let installed = false;

/** Wraps werift's `UdpTransport.init` once per process. */
function installMux(): void {
  if (installed) return;
  installed = true;
  const original = UdpTransport.init.bind(UdpTransport);
  UdpTransport.init = (async (type, options) => {
    const owner = owners.getStore();
    if (owner === undefined || type !== 'udp4' || owner.closed) return original(type, options);
    return owner.transport() as unknown as UdpTransport;
  }) as typeof UdpTransport.init;
}

const key = (ip: string, port: number): string => `${ip}:${port}`;

function isStun(data: Buffer): boolean {
  return data.length >= 20 && (data[0]! & 0xc0) === 0 && data.readUInt32BE(4) === STUN_MAGIC;
}

/** 0 request, 1 indication, 2 success response, 3 error response. */
function stunClass(data: Buffer): number {
  const type = data.readUInt16BE(0);
  return ((type >> 7) & 0x2) | ((type >> 4) & 0x1);
}

/** The first half of a STUN message's USERNAME (the receiver's ufrag), or null. */
function stunTargetUfrag(data: Buffer): string | null {
  const end = Math.min(data.length, 20 + data.readUInt16BE(2));
  for (let at = 20; at + 4 <= end; ) {
    const type = data.readUInt16BE(at);
    const length = data.readUInt16BE(at + 2);
    if (at + 4 + length > end) return null;
    if (type === STUN_USERNAME) {
      const username = data.toString('utf8', at + 4, at + 4 + length);
      const colon = username.indexOf(':');
      return colon > 0 ? username.slice(0, colon) : null;
    }
    at += 4 + ((length + 3) & ~3);
  }
  return null;
}

/** A werift transport whose datagrams go through the mux's socket. */
class MuxTransport {
  readonly type = 'udp';
  closed = false;
  rinfo?: Partial<Pick<RemoteInfo, 'address' | 'port'>>;
  onData: (data: Buffer, addr: Address) => void = () => {};
  /** Remote addresses routed to this transport, forgotten when it closes. */
  readonly remotes = new Set<string>();

  constructor(
    private readonly mux: UdpMux,
    readonly owner: MuxOwner,
  ) {}

  send = async (data: Buffer, addr?: Address): Promise<void> => {
    if (this.closed || addr === undefined) return;
    await this.mux.send(this, data, addr);
  };

  get address(): { address: string; family: string; port: number } {
    return { address: '0.0.0.0', family: 'IPv4', port: this.mux.port };
  }

  get addressFamily(): 4 {
    return 4;
  }

  get host(): string {
    return '0.0.0.0';
  }

  get port(): number {
    return this.mux.port;
  }

  close = async (): Promise<void> => {
    if (this.closed) return;
    this.closed = true;
    this.mux.forget(this);
    this.owner.transports.delete(this);
  };
}

/** One peer connection's share of the mux: the transports werift made for it and its ICE ufrag. */
export class MuxOwner {
  readonly transports = new Set<MuxTransport>();
  private ufragValue: string | null = null;
  closed = false;

  constructor(private readonly mux: UdpMux) {}

  /** Runs `fn` so that the transports werift makes inside it belong to this owner. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return owners.run(this, fn);
  }

  /** The connection's local ICE ufrag (`a=ice-ufrag` of its description): STUN requests naming it come here. */
  set ufrag(value: string) {
    this.mux.claim(this, value, this.ufragValue);
    this.ufragValue = value;
  }

  transport(): MuxTransport {
    const transport = new MuxTransport(this.mux, this);
    this.transports.add(transport);
    return transport;
  }

  /** Forgets every route to this owner's transports; werift closes them itself, this covers a missed close. */
  close(): void {
    this.closed = true;
    for (const t of [...this.transports]) void t.close();
    if (this.ufragValue !== null) this.mux.claim(this, null, this.ufragValue);
  }
}

export class UdpMux {
  private readonly byUfrag = new Map<string, MuxOwner>();
  private readonly byRemote = new Map<string, MuxTransport>();
  private readonly byTransaction = new Map<string, { transport: MuxTransport; at: number }>();

  private constructor(
    private readonly socket: Socket,
    readonly port: number,
  ) {
    socket.on('message', (data, rinfo) => this.receive(data, rinfo));
    socket.on('error', (err) => console.error('rtc udp socket', err));
  }

  /** Binds `port` on every IPv4 interface. */
  static async open(port: number): Promise<UdpMux> {
    installMux();
    const socket = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ port, exclusive: true }, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    return new UdpMux(socket, port);
  }

  owner(): MuxOwner {
    return new MuxOwner(this);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  /** @internal */
  claim(owner: MuxOwner, ufrag: string | null, previous: string | null): void {
    if (previous !== null && this.byUfrag.get(previous) === owner) this.byUfrag.delete(previous);
    if (ufrag !== null) this.byUfrag.set(ufrag, owner);
  }

  /** @internal */
  forget(transport: MuxTransport): void {
    for (const remote of transport.remotes) if (this.byRemote.get(remote) === transport) this.byRemote.delete(remote);
    transport.remotes.clear();
    for (const [id, route] of this.byTransaction) if (route.transport === transport) this.byTransaction.delete(id);
  }

  /** @internal */
  send(transport: MuxTransport, data: Buffer, [host, port]: Address): Promise<void> {
    if (isStun(data) && stunClass(data) === 0) {
      this.pruneTransactions();
      const id = data.toString('hex', 8, 20);
      this.byTransaction.delete(id); // a resend moves to the end, keeping the map in time order
      this.byTransaction.set(id, { transport, at: Date.now() });
    }
    this.route(key(host, port), transport);
    return new Promise((resolve, reject) => {
      this.socket.send(data, port, host, (err) => (err ? reject(err) : resolve()));
    });
  }

  private route(remote: string, transport: MuxTransport): void {
    if (this.byRemote.get(remote) === transport) return;
    this.byRemote.set(remote, transport);
    transport.remotes.add(remote);
  }

  private receive(data: Buffer, rinfo: RemoteInfo): void {
    const remote = key(rinfo.address, rinfo.port);
    let transport: MuxTransport | undefined;
    if (isStun(data)) {
      const kind = stunClass(data);
      if (kind === 0) {
        const ufrag = stunTargetUfrag(data);
        const owner = ufrag === null ? undefined : this.byUfrag.get(ufrag);
        transport = owner === undefined ? undefined : [...owner.transports].find((t) => !t.closed);
        if (transport !== undefined) this.route(remote, transport);
      } else if (kind >= 2) {
        transport = this.byTransaction.get(data.toString('hex', 8, 20))?.transport;
      }
    }
    transport ??= this.byRemote.get(remote);
    if (transport === undefined || transport.closed) return;
    transport.rinfo = { address: rinfo.address, port: rinfo.port };
    try {
      transport.onData(data, [rinfo.address, rinfo.port]);
    } catch (err) {
      console.error('rtc datagram', err);
    }
  }

  private pruneTransactions(): void {
    const stale = Date.now() - TRANSACTION_MS;
    for (const [id, route] of this.byTransaction) {
      if (route.at >= stale) break; // inserted in time order
      this.byTransaction.delete(id);
    }
  }
}
