import type { TsPacket } from './ts-packet';

export interface PesPacket {
  readonly pid: number;
  readonly streamId: number;
  /** 90 kHz. */
  readonly pts?: number;
  readonly dts?: number;
  readonly payload: Uint8Array;
}

interface PidState {
  chunks: Uint8Array[];
  size: number;
  lastCc: number;
  broken: boolean;
}

/** Stream ids whose PES packets carry no optional header (ISO 13818-1 Table 2-21). */
const NO_HEADER_STREAM_IDS = new Set([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff]);

export function readTimestamp(d: Uint8Array, o: number): number {
  return ((d[o] >> 1) & 0x07) * 0x40000000 + ((d[o + 1] << 22) | ((d[o + 2] >> 1) << 15) | (d[o + 3] << 7) | (d[o + 4] >> 1));
}

/** Reassembles PES packets per PID. A PES completes at the next unit start on its PID, or on flush(). */
export class PesAssembler {
  continuityErrors = 0;
  private readonly states = new Map<number, PidState>();

  constructor(private readonly onPes: (pes: PesPacket) => void) {}

  push(packet: TsPacket): void {
    if (!packet.hasPayload) return; // CC does not advance on adaptation-only packets
    const state = this.states.get(packet.pid);
    if (packet.payloadUnitStart) {
      if (state) this.emit(packet.pid, state);
      this.states.set(packet.pid, { chunks: [packet.payload], size: packet.payload.length, lastCc: packet.continuityCounter, broken: false });
      return;
    }
    if (!state) return; // joined mid-PES (after a seek); wait for the next unit start
    if (packet.continuityCounter === state.lastCc) return; // duplicate packet
    if (packet.continuityCounter !== ((state.lastCc + 1) & 0x0f)) {
      state.broken = true;
      this.continuityErrors++;
    }
    state.lastCc = packet.continuityCounter;
    state.chunks.push(packet.payload);
    state.size += packet.payload.length;
  }

  flush(): void {
    for (const [pid, state] of this.states) this.emit(pid, state);
    this.states.clear();
  }

  reset(): void {
    this.states.clear();
  }

  private emit(pid: number, state: PidState): void {
    if (state.broken) return;
    const data = new Uint8Array(state.size);
    let at = 0;
    for (const chunk of state.chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }
    const pes = parsePes(pid, data);
    if (pes) this.onPes(pes);
  }
}

function parsePes(pid: number, d: Uint8Array): PesPacket | null {
  if (d.length < 6 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return null;
  const streamId = d[3];
  const declared = (d[4] << 8) | d[5];
  const end = declared === 0 ? d.length : Math.min(d.length, 6 + declared);
  if (NO_HEADER_STREAM_IDS.has(streamId)) return { pid, streamId, payload: d.subarray(6, end) };
  if (d.length < 9) return null;
  const ptsDtsFlags = d[7] >> 6;
  const headerEnd = 9 + d[8];
  if (headerEnd > end) return null;
  return {
    pid,
    streamId,
    pts: ptsDtsFlags & 0x2 ? readTimestamp(d, 9) : undefined,
    dts: ptsDtsFlags === 0x3 ? readTimestamp(d, 14) : undefined,
    payload: d.subarray(headerEnd, end),
  };
}
