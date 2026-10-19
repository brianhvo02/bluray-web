import { RTCPeerConnection } from 'werift';
import type { RTCDataChannel } from 'werift';
import { SIGNAL_DEVICE_LIFETIME_MS } from '../../../rendezvous/src/protocol';
import type { WireChannel } from '../../../src/engine/disc/rtc-wire';
import type { Auth, DeviceRoute } from '../auth';
import type { Handler } from '../http';
import { serveChannel } from './dispatch';
import { neverDockerOrTailscale } from './public-address';
import { UdpMux } from './udp-mux';
import type { MuxOwner } from './udp-mux';

/** An ICE server as `RTCPeerConnection` takes it. */
export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface PeerLimits {
  /** Offers one device socket (`sid`) may make; more are refused. */
  offersPerSid: number;
  /** Peer connections at once; more are refused. */
  peers: number;
  /** A peer whose `api` channel hasn't opened this long after its offer is dropped. */
  unopenedMs: number;
}

const DEFAULT_LIMITS: PeerLimits = { offersPerSid: 4, peers: 16, unopenedMs: 30_000 };
/** How long to wait for werift's first local candidate before answering (the answer's candidates are ours anyway). */
const GATHER_WAIT_MS = 2_000;

/** Why an offer was refused, sent back to the device as the answer's `error`. */
export class RtcRefused extends Error {
  constructor(readonly reason: 'busy' | 'too-many-offers') {
    super(reason);
    this.name = 'RtcRefused';
  }
}

export interface RtcPeersOptions {
  handlers: readonly Handler[];
  auth: Auth;
  /** The one UDP port ICE uses (47998). */
  port: number;
  /** The addresses the answer advertises as host candidates on `port`. */
  advertise: () => string[];
  iceServers: () => Promise<RTCIceServerLike[]>;
  now: () => number;
  limits?: Partial<PeerLimits>;
}

interface Peer {
  readonly sid: string;
  readonly pc: RTCPeerConnection;
  readonly owner: MuxOwner;
  timer: NodeJS.Timeout | undefined;
  served: { close(): void } | null;
  closed: boolean;
}

interface CandidateLike {
  readonly type: string;
}

/** The route a session over the selected pair counts as: `relay` when either end is a TURN relay candidate. */
export function routeOf(pair: { localCandidate: CandidateLike; remoteCandidate: CandidateLike } | undefined): Extract<DeviceRoute, 'webrtc' | 'relay'> {
  return pair !== undefined && (pair.localCandidate.type === 'relay' || pair.remoteCandidate.type === 'relay') ? 'relay' : 'webrtc';
}

/**
 * `sdp` with its candidates replaced by host candidates for `addresses` on `port` (Docker and Tailscale addresses
 * dropped), followed by end-of-candidates, and its connection lines pointing at the first address.
 */
export function answerWithCandidates(sdp: string, addresses: readonly string[], port: number): string {
  const ips = [...new Set(addresses.filter(neverDockerOrTailscale))];
  const lines = sdp.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('a=candidate:') && l !== 'a=end-of-candidates');
  const candidates = [...ips.map((ip, i) => `a=candidate:${i + 1} 1 udp ${2130706431 - i * 256} ${ip} ${port} typ host generation 0`), 'a=end-of-candidates'];
  const out: string[] = [];
  let inMedia = false;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      if (inMedia) out.push(...candidates);
      inMedia = true;
    }
    out.push(ips.length > 0 && line.startsWith('c=IN IP4 ') ? `c=IN IP4 ${ips[0]}` : line);
  }
  if (inMedia) out.push(...candidates);
  return `${out.join('\r\n')}\r\n`;
}

/** An SDP's first `a=ice-<name>` value. */
function iceAttribute(sdp: string, name: 'ufrag' | 'pwd'): string | undefined {
  return new RegExp(`^a=ice-${name}:(\\S+)`, 'm').exec(sdp)?.[1];
}

/**
 * A werift data channel as the wire sees it. `onClosed` runs once when the channel closes, whoever holds `onclose`.
 */
export function wireChannelOf(dc: RTCDataChannel, onClosed?: () => void): WireChannel {
  let onbufferedamountlow: (() => void) | null = null;
  let onmessage: ((data: string | Uint8Array) => void) | null = null;
  let onclose: (() => void) | null = null;
  let closed = false;
  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    onclose?.();
    onClosed?.();
  };
  dc.bufferedAmountLow.subscribe(() => onbufferedamountlow?.());
  dc.onMessage.subscribe((m) => onmessage?.(typeof m === 'string' ? m : new Uint8Array(m.buffer, m.byteOffset, m.byteLength)));
  dc.stateChanged.subscribe((state) => {
    if (state === 'closed') fireClose();
  });
  if (dc.readyState === 'closed') queueMicrotask(fireClose);
  return {
    send(data) {
      if (dc.readyState !== 'open') throw new Error('InvalidStateError: the channel is not open');
      dc.send(typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return dc.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(value) {
      dc.bufferedAmountLowThreshold = value;
    },
    get onbufferedamountlow() {
      return onbufferedamountlow;
    },
    set onbufferedamountlow(listener) {
      onbufferedamountlow = listener;
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(listener) {
      onmessage = listener;
    },
    get onclose() {
      return onclose;
    },
    set onclose(listener) {
      onclose = listener;
    },
    close() {
      try {
        dc.close();
      } finally {
        fireClose();
      }
    },
  };
}

/**
 * The NAS's WebRTC peers: one werift `RTCPeerConnection` per device socket (`sid`), all on one UDP port, each
 * answering requests from its `api` data channel through `serveChannel`. An answer advertises only the configured
 * addresses as host candidates on that port.
 */
export class RtcPeers {
  private readonly peers = new Map<string, Peer>();
  private readonly offers = new Map<string, { count: number; since: number }>();
  private readonly limits: PeerLimits;
  private muxing: Promise<UdpMux> | undefined;

  constructor(private readonly opts: RtcPeersOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
  }

  /** Peer connections open now. */
  get size(): number {
    return this.peers.size;
  }

  async answer(sid: string, offer: string): Promise<{ answer: string }> {
    this.countOffer(sid);
    this.admit(sid);
    const mux = await this.mux();
    const iceServers = await this.opts.iceServers();
    this.admit(sid); // again: another offer may have come in while this one waited
    const { port } = this.opts;
    const pc = new RTCPeerConnection({
      iceServers,
      // werift refuses a range with equal ends, so it is narrowed after construction. The mux serves every
      // connection's ICE on `port`; the narrow range keeps a transport the mux doesn't serve on it too.
      icePortRange: [port, port + 1],
      iceUseIpv4: true,
      iceUseIpv6: false,
      iceUseLinkLocalAddress: false,
      iceStunGatherTimeout: 2,
    });
    pc.config.icePortRange = [port, port];
    const peer: Peer = { sid, pc, owner: mux.owner(), timer: undefined, served: null, closed: false };
    this.peers.set(sid, peer);
    peer.timer = setTimeout(() => this.drop(peer), this.limits.unopenedMs);
    peer.timer.unref();
    pc.onDataChannel.subscribe((dc) => this.channel(peer, dc));
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') this.drop(peer);
    });

    try {
      const gathered = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, GATHER_WAIT_MS);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        pc.onIceCandidate.subscribe(done);
        pc.iceGatheringStateChange.subscribe((state) => state === 'complete' && done());
      });
      await peer.owner.run(async () => {
        await pc.setRemoteDescription({ type: 'offer', sdp: offer });
        await pc.setLocalDescription(await pc.createAnswer());
      });
      const local = pc.localDescription?.sdp;
      const ufrag = local === undefined ? undefined : iceAttribute(local, 'ufrag');
      const password = local === undefined ? undefined : iceAttribute(local, 'pwd');
      const remoteUfrag = iceAttribute(offer, 'ufrag');
      if (ufrag === undefined || password === undefined) throw new Error('werift made no answer');
      if (remoteUfrag === undefined) throw new Error('the offer has no ICE ufrag');
      peer.owner.claim(ufrag, remoteUfrag, password); // a MuxConflict drops the peer below
      await gathered;
      if (peer.closed) throw new Error('the peer closed while answering');
      return { answer: answerWithCandidates(pc.localDescription!.sdp, this.opts.advertise(), port) };
    } catch (err) {
      this.drop(peer);
      throw err;
    }
  }

  /** Binds the UDP port now rather than at the first offer, so a port in use shows at start. */
  async listen(): Promise<void> {
    await this.mux();
  }

  /** A device's trickled ICE candidate; ignored without a peer for `sid` or when malformed. */
  candidate(sid: string, c: unknown): void {
    const peer = this.peers.get(sid);
    if (peer === undefined || typeof c !== 'object' || c === null) return;
    const { candidate, sdpMid, sdpMLineIndex } = c as Record<string, unknown>;
    if (typeof candidate !== 'string' || candidate === '' || candidate.length > 1024) return;
    const init = {
      candidate,
      sdpMid: typeof sdpMid === 'string' ? sdpMid : undefined,
      sdpMLineIndex: typeof sdpMLineIndex === 'number' ? sdpMLineIndex : undefined,
    };
    peer.pc.addIceCandidate(init).catch(() => {
      // a candidate werift can't use is the device's problem, not the connection's
    });
  }

  /** Closes every peer and the UDP port. */
  async closeAll(): Promise<void> {
    for (const peer of [...this.peers.values()]) this.drop(peer);
    const muxing = this.muxing;
    this.muxing = undefined;
    const mux = await muxing?.catch(() => undefined);
    await mux?.close();
  }

  /** Makes room for a new peer for `sid`: its old peer goes, and the offer is refused when the limit is reached. */
  private admit(sid: string): void {
    const previous = this.peers.get(sid);
    if (previous) this.drop(previous);
    if (this.peers.size >= this.limits.peers) throw new RtcRefused('busy');
  }

  private countOffer(sid: string): void {
    const now = this.opts.now();
    for (const [id, entry] of this.offers) if (entry.since <= now - SIGNAL_DEVICE_LIFETIME_MS) this.offers.delete(id);
    const entry = this.offers.get(sid) ?? { count: 0, since: now };
    if (entry.count >= this.limits.offersPerSid) throw new RtcRefused('too-many-offers');
    entry.count++;
    this.offers.set(sid, entry);
  }

  private mux(): Promise<UdpMux> {
    this.muxing ??= UdpMux.open(this.opts.port).catch((err: unknown) => {
      this.muxing = undefined;
      throw err;
    });
    return this.muxing;
  }

  private channel(peer: Peer, dc: RTCDataChannel): void {
    if (dc.label !== 'api' || peer.served !== null || peer.closed) {
      dc.close();
      return;
    }
    const serve = (): void => {
      if (peer.closed || peer.served !== null) return;
      clearTimeout(peer.timer);
      const pair = peer.pc.iceTransports[0]?.connection.nominated;
      const channel = wireChannelOf(dc, () => this.drop(peer));
      peer.served = serveChannel(channel, this.opts.handlers, {
        auth: this.opts.auth,
        // The device's address as packets arrive from it; unknown, a bucket of its own for the pairing limits.
        remoteAddress: pair?.remoteAddr[0] ?? `webrtc:${peer.sid}`,
        now: this.opts.now,
        onSession: (deviceId) => this.opts.auth.noteRoute(deviceId, routeOf(peer.pc.iceTransports[0]?.connection.nominated)),
      });
    };
    if (dc.readyState === 'open') serve();
    else
      dc.stateChanged.subscribe((state) => {
        if (state === 'open') serve();
      });
  }

  private drop(peer: Peer): void {
    if (peer.closed) return;
    peer.closed = true;
    clearTimeout(peer.timer);
    if (this.peers.get(peer.sid) === peer) this.peers.delete(peer.sid);
    peer.served?.close();
    peer.pc.close().catch(() => {});
    peer.owner.close();
  }
}
