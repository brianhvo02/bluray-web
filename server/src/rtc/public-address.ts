import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';

const MAGIC = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const MAPPED_ADDRESS = 0x0001;
const XOR_MAPPED_ADDRESS = 0x0020;
/** Resends of the Binding request while waiting, in ms after the first (RFC 5389's doubling, cut short). */
const RESENDS_MS = [500, 1500, 3500];
const HOUR = 60 * 60_000;

/**
 * Whether the NAS may advertise `ip` as a candidate: an IPv4 address outside Docker's 172.16.0.0/12 and
 * Tailscale's 100.64.0.0/10, which no device elsewhere can reach.
 */
export function advertisable(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/** `stun:host:port` as [host, port], or null. */
function parseStunUrl(url: string): [string, number] | null {
  const m = /^stun:([^:]+):(\d{1,5})$/.exec(url);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port <= 65535 ? [m[1]!, port] : null;
}

/** The IPv4 address of a Binding success response to `txid`, or null. */
function mappedAddress(msg: Buffer, txid: Buffer): string | null {
  if (msg.length < 20 || msg.readUInt16BE(0) !== BINDING_SUCCESS || msg.readUInt32BE(4) !== MAGIC || !msg.subarray(8, 20).equals(txid)) return null;
  const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
  let plain: string | null = null;
  for (let at = 20; at + 4 <= end; ) {
    const type = msg.readUInt16BE(at);
    const length = msg.readUInt16BE(at + 2);
    const value = at + 4;
    if (value + length > end) break;
    if ((type === XOR_MAPPED_ADDRESS || type === MAPPED_ADDRESS) && length >= 8 && msg.readUInt8(value + 1) === 0x01) {
      let raw = msg.readUInt32BE(value + 4);
      if (type === XOR_MAPPED_ADDRESS) raw = (raw ^ MAGIC) >>> 0;
      const ip = [raw >>> 24, (raw >>> 16) & 0xff, (raw >>> 8) & 0xff, raw & 0xff].join('.');
      if (type === XOR_MAPPED_ADDRESS) return ip;
      plain = ip;
    }
    at = value + ((length + 3) & ~3);
  }
  return plain;
}

/**
 * This host's public IPv4 address as the STUN server `stun` (`stun:host:port`) sees it, or null when the server
 * doesn't answer within `timeoutMs` or the URL is not a STUN URL.
 */
export function discoverPublicIpv4(stun: string, timeoutMs: number): Promise<string | null> {
  const server = parseStunUrl(stun);
  if (server === null) return Promise.resolve(null);
  const [host, port] = server;
  const txid = randomBytes(12);
  const request = Buffer.alloc(20);
  request.writeUInt16BE(BINDING_REQUEST, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(MAGIC, 4);
  txid.copy(request, 8);

  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const finish = (ip: string | null): void => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(ip);
    };
    const send = (): void => {
      if (!done) socket.send(request, port, host, (err) => err && finish(null));
    };
    socket.on('error', () => finish(null));
    socket.on('message', (msg) => {
      const ip = mappedAddress(msg, txid);
      if (ip !== null) finish(ip);
    });
    socket.bind(0, () => {
      send();
      for (const at of RESENDS_MS) if (at < timeoutMs) timers.push(setTimeout(send, at));
    });
    timers.push(setTimeout(() => finish(null), timeoutMs));
  });
}

export interface AdvertiserOptions {
  /** `stun:host:port`. */
  stun: string;
  /** `RTC_LAN_ADDRESS`, advertised after the public address. */
  lan?: string;
  /** `RTC_ADVERTISE`: advertised as is, and nothing is discovered. */
  fixed?: readonly string[];
  timeoutMs?: number;
  /** Between refreshes; an hour by default. */
  intervalMs?: number;
  /** Where a refresh that got no answer, or a changed address, is reported; `console.warn` by default. */
  log?: (message: string) => void;
}

/**
 * The addresses the NAS advertises as its ICE candidates: its public IPv4 (found by STUN at start and then hourly,
 * so a changed address is picked up without a restart) and its LAN address. A refresh that gets no answer keeps the
 * last public address. Docker and Tailscale addresses are never advertised.
 */
export class AddressAdvertiser {
  private publicIp: string | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: AdvertiserOptions) {}

  private log(message: string): void {
    (this.opts.log ?? console.warn)(message);
  }

  advertise(): string[] {
    if (this.opts.fixed) return this.opts.fixed.filter(advertisable);
    const list = [this.publicIp, this.opts.lan].filter((ip): ip is string => ip != null && advertisable(ip));
    return [...new Set(list)];
  }

  async refresh(): Promise<void> {
    if (this.opts.fixed) return;
    const ip = await discoverPublicIpv4(this.opts.stun, this.opts.timeoutMs ?? 5000);
    if (ip === null) {
      this.log(`STUN ${this.opts.stun} did not answer; keeping ${this.publicIp === null ? 'no public address' : 'the last public address'}`);
      return;
    }
    if (ip !== this.publicIp && this.publicIp !== null) this.log('the public IPv4 address changed; advertising the new one');
    this.publicIp = ip;
  }

  /** Refreshes now, then every interval until `stop`. */
  async start(): Promise<void> {
    if (this.opts.fixed) return;
    await this.refresh();
    this.stop();
    const tick = (): void => {
      this.timer = setTimeout(() => {
        void this.refresh().finally(() => {
          if (this.timer !== undefined) tick();
        });
      }, this.opts.intervalMs ?? HOUR);
      this.timer.unref();
    };
    tick();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
