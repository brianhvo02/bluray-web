export interface MuxUnit {
  pid: number;
  streamId: number;
  /** 90 kHz. */
  pts: number;
  dts?: number;
  payload: Uint8Array;
  /** Written as PES_extension_2 (Blu-ray TrueHD/AC-3 substreams use stream_id 0xFD with 0x72/0x76). */
  streamIdExtension?: number;
}

export interface MuxResult {
  bytes: Uint8Array<ArrayBuffer>;
  /** Source packet number of each unit's first packet. */
  unitSpns: number[];
}

export function writeTimestamp(out: Uint8Array, offset: number, prefix: number, ts: number): void {
  const low30 = ts % 0x40000000;
  const high3 = Math.floor(ts / 0x40000000) & 0x7;
  out[offset] = (prefix << 4) | (high3 << 1) | 1;
  out[offset + 1] = (low30 >>> 22) & 0xff;
  out[offset + 2] = (((low30 >>> 15) & 0x7f) << 1) | 1;
  out[offset + 3] = (low30 >>> 7) & 0xff;
  out[offset + 4] = ((low30 & 0x7f) << 1) | 1;
}

function buildPes(u: MuxUnit): Uint8Array {
  const hasDts = u.dts !== undefined && u.dts !== u.pts;
  const hasExt = u.streamIdExtension !== undefined;
  const tsBytes = hasDts ? 10 : 5;
  const headerDataLength = tsBytes + (hasExt ? 3 : 0);
  const length = 3 + headerDataLength + u.payload.length;
  const out = new Uint8Array(6 + length);
  out.set([0, 0, 1, u.streamId], 0);
  const declared = length > 0xffff ? 0 : length;
  out[4] = declared >> 8;
  out[5] = declared & 0xff;
  out[6] = 0x80;
  out[7] = (hasDts ? 0xc0 : 0x80) | (hasExt ? 0x01 : 0);
  out[8] = headerDataLength;
  writeTimestamp(out, 9, hasDts ? 0x3 : 0x2, u.pts);
  if (hasDts && u.dts !== undefined) writeTimestamp(out, 14, 0x1, u.dts);
  if (hasExt) {
    const e = 9 + tsBytes;
    out[e] = 0x01; // PES_extension_flag_2 only
    out[e + 1] = 0x81; // marker bit + PES_extension_field_length 1
    out[e + 2] = (u.streamIdExtension ?? 0) & 0x7f; // stream_id_extension_flag 0
  }
  out.set(u.payload, 9 + headerDataLength);
  return out;
}

function sourcePacket(index: number): Uint8Array {
  const pkt = new Uint8Array(192);
  const ats = index & 0x3fffffff;
  pkt[0] = (ats >>> 24) & 0x3f;
  pkt[1] = (ats >>> 16) & 0xff;
  pkt[2] = (ats >>> 8) & 0xff;
  pkt[3] = ats & 0xff;
  pkt[4] = 0x47;
  return pkt;
}

export function muxM2ts(units: readonly MuxUnit[]): MuxResult {
  const packets: Uint8Array[] = [];
  const counters = new Map<number, number>();
  const unitSpns: number[] = [];
  for (const unit of units) {
    unitSpns.push(packets.length);
    const pes = buildPes(unit);
    let offset = 0;
    let first = true;
    while (offset < pes.length) {
      const take = Math.min(184, pes.length - offset);
      const counter = counters.get(unit.pid) ?? 0;
      counters.set(unit.pid, (counter + 1) & 0x0f);
      const pkt = sourcePacket(packets.length);
      pkt[5] = (first ? 0x40 : 0) | ((unit.pid >> 8) & 0x1f);
      pkt[6] = unit.pid & 0xff;
      if (take < 184) {
        const afLength = 183 - take;
        pkt[7] = 0x30 | counter;
        pkt[8] = afLength;
        if (afLength > 0) {
          pkt[9] = 0x00;
          pkt.fill(0xff, 10, 9 + afLength);
        }
        pkt.set(pes.subarray(offset, offset + take), 9 + afLength);
      } else {
        pkt[7] = 0x10 | counter;
        pkt.set(pes.subarray(offset, offset + 184), 8);
      }
      packets.push(pkt);
      offset += take;
      first = false;
    }
  }
  while (packets.length % 32 !== 0) {
    const pkt = sourcePacket(packets.length);
    pkt[5] = 0x1f;
    pkt[6] = 0xff;
    pkt[7] = 0x10;
    pkt.fill(0xff, 8);
    packets.push(pkt);
  }
  const bytes = new Uint8Array(packets.length * 192);
  packets.forEach((p, i) => bytes.set(p, i * 192));
  return { bytes, unitSpns };
}
