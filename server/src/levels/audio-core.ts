import { CodingType } from '../../../src/engine/bdmv/stream-types';
import { AudioFramer, type AudioFrame } from '../../../src/engine/decode/audio-frames';
import { parseLpcmHeader } from '../../../src/engine/decode/lpcm';
import { SOURCE_PACKET_SIZE } from '../../../src/engine/demux/constants';
import { PesAssembler, type PesPacket } from '../../../src/engine/demux/pes-assembler';
import { parseSourcePacket } from '../../../src/engine/demux/ts-packet';
import { coreCoding } from './levels';

/** PES stream_id_extension of the AC-3 substream inside a Blu-ray TrueHD PID, and of the TrueHD (MLP) units. */
const AC3_CORE_EXTENSION = 0x76;
const MLP_EXTENSION = 0x72;
const SAMPLE_RATE = 48_000;
const TS_PAYLOAD = 184;
const PAT_PID = 0;
/** The PMT PID of every Blu-ray clip (CLPI program_map_PID). */
const BD_PMT_PID = 0x0100;

/** A whole PES packet parsed with the engine's demuxer: header fields, and where its payload starts and ends. */
function parsePes(pes: Uint8Array): (PesPacket & { headerEnd: number; payloadEnd: number }) | null {
  const out: PesPacket[] = [];
  const assembler = new PesAssembler((p) => out.push(p));
  assembler.push({ pid: 0, payloadUnitStart: true, continuityCounter: 0, hasPayload: true, payload: pes });
  assembler.flush();
  const p = out[0];
  if (!p) return null;
  // The assembler hands over a subarray of a fresh copy of `pes`, so its offset is the header's length.
  return { ...p, headerEnd: p.payload.byteOffset, payloadEnd: p.payload.byteOffset + p.payload.length };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Reduces one audio PID's PES packets to the core a level carries (spec §5.2), bit-exact: TrueHD keeps only its AC-3
 * substream (stream_id_extension 0x76, or AC-3 sync 0x0B77 where the PES carries no extension) and drops the MLP units;
 * DTS-HD keeps only the DTS core frames (sync 0x7FFE8001) and drops the extension substream. Other codings pass through.
 */
export class PesCoreFilter {
  constructor(private readonly codingType: number) {}

  /** The PES to carry (the same object when unchanged, a shorter one when frames were removed), or null to drop it. */
  push(pes: Uint8Array): Uint8Array | null {
    if (this.codingType === CodingType.TRUEHD) return this.truehd(pes);
    if (this.codingType === CodingType.DTSHD || this.codingType === CodingType.DTSHD_MASTER) return this.dtshd(pes);
    return pes;
  }

  private truehd(pes: Uint8Array): Uint8Array | null {
    const parsed = parsePes(pes);
    if (!parsed) return null;
    if (parsed.streamIdExtension === AC3_CORE_EXTENSION) return pes;
    if (parsed.streamIdExtension === MLP_EXTENSION) return null;
    return parsed.payload[0] === 0x0b && parsed.payload[1] === 0x77 ? pes : null;
  }

  private dtshd(pes: Uint8Array): Uint8Array | null {
    const parsed = parsePes(pes);
    if (!parsed) return null;
    // The engine's DTS framer returns the core frames and drops the extension substream (as the player does).
    const cores = new AudioFramer('dts').push(parsed.payload, 0).map((f) => f.data);
    if (cores.length === 0) return null;
    const payload = concat(cores);
    if (payload.length === parsed.payload.length) return pes;
    const out = new Uint8Array(parsed.headerEnd + payload.length);
    out.set(pes.subarray(0, parsed.headerEnd));
    out.set(payload, parsed.headerEnd);
    const declared = (pes[4]! << 8) | pes[5]!;
    if (declared !== 0) {
      const length = out.length - 6;
      out[4] = length >> 8;
      out[5] = length & 0xff;
    }
    return out;
  }
}

/** Bytes per second × 8 of one frame: its size over its duration at 48 kHz, rounded up. */
function frameBps(bytes: number, samples: number): number {
  return Math.ceil((bytes * 8 * SAMPLE_RATE) / samples);
}

/** Starts an E-AC-3 access unit: an AC-3 frame, or an E-AC-3 independent substream 0. */
function startsAc3Unit(f: Uint8Array): boolean {
  if (f[5]! >> 3 <= 10) return true;
  return f[2]! >> 6 !== 1 && ((f[2]! >> 3) & 0x07) === 0;
}

/**
 * The nominal rate of what a level carries for an audio stream, read from its first frame: AC-3 and E-AC-3 (an access
 * unit's frames, dependent substreams included), TrueHD by its AC-3 core frame, DTS and DTS-HD by their core frame,
 * LPCM from its header. Throws when the frame can't be read.
 */
export function nominalAudioBps(codingType: number, firstFrame: Uint8Array): number {
  const fail = (): never => {
    throw new Error(`levels: can't read the nominal rate of a 0x${codingType.toString(16)} audio frame`);
  };
  switch (codingType) {
    case CodingType.LPCM: {
      if (firstFrame.length < 4) return fail();
      const bitsCode = firstFrame[3]! >> 6;
      if (bitsCode === 0) return fail();
      // 20-bit samples are stored as 24 bits; the engine's parser refuses them, so read the layout as 24-bit.
      const header = parseLpcmHeader(Uint8Array.from([0, 0, firstFrame[2]!, (firstFrame[3]! & 0x3f) | 0xc0]));
      return header.storedChannels * header.sampleRate * (bitsCode === 1 ? 16 : 24);
    }
    case CodingType.AC3:
    case CodingType.TRUEHD:
    case CodingType.EAC3:
    case CodingType.EAC3_SECONDARY: {
      const frames: AudioFrame[] = new AudioFramer('ac3').push(firstFrame, 0);
      const first = frames[0];
      if (!first) return fail();
      let bytes = first.data.length;
      for (const f of frames.slice(1)) {
        if (startsAc3Unit(f.data)) break;
        bytes += f.data.length;
      }
      return frameBps(bytes, first.samples);
    }
    case CodingType.DTS:
    case CodingType.DTSHD:
    case CodingType.DTSHD_MASTER: {
      const first = new AudioFramer('dts').push(firstFrame, 0)[0];
      if (!first) return fail();
      return frameBps(first.data.length, first.samples);
    }
    default:
      return fail();
  }
}

/** MPEG-2 CRC-32 (polynomial 0x04C11DB7, no reflection), as PSI sections carry it. Over a whole section it is 0. */
export function mpegCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

export interface PmtStream {
  readonly pid: number;
  readonly streamType: number;
  /** The ES_info descriptors, as bytes. */
  readonly descriptors?: Uint8Array;
}

export interface PmtProgram {
  /** Default 1, as on Blu-ray. */
  readonly programNumber?: number;
  /** Default: the first video stream's PID, else the first stream's. */
  readonly pcrPid?: number;
  readonly version?: number;
  /** The program_info descriptors, as bytes. */
  readonly programInfo?: Uint8Array;
}

const VIDEO_STREAM_TYPES = new Set<number>([0x01, 0x02, 0x1b, 0x20, 0x24, 0xea]);

/** A PMT section (with its CRC) listing exactly `streams`, in order. */
export function pmtFor(streams: readonly PmtStream[], program: PmtProgram = {}): Uint8Array {
  const programInfo = program.programInfo ?? new Uint8Array(0);
  const pcrPid = program.pcrPid ?? (streams.find((s) => VIDEO_STREAM_TYPES.has(s.streamType)) ?? streams[0])?.pid ?? 0x1fff;
  const programNumber = program.programNumber ?? 1;
  const body: number[] = [
    0x02,
    0,
    0,
    programNumber >> 8,
    programNumber & 0xff,
    0xc1 | (((program.version ?? 0) & 0x1f) << 1),
    0x00,
    0x00,
    0xe0 | (pcrPid >> 8),
    pcrPid & 0xff,
    0xf0 | (programInfo.length >> 8),
    programInfo.length & 0xff,
    ...programInfo,
  ];
  for (const s of streams) {
    const d = s.descriptors ?? new Uint8Array(0);
    body.push(s.streamType, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0 | (d.length >> 8), d.length & 0xff, ...d);
  }
  const sectionLength = body.length - 3 + 4;
  body[1] = 0xb0 | (sectionLength >> 8);
  body[2] = sectionLength & 0xff;
  const section = new Uint8Array(body.length + 4);
  section.set(body);
  const crc = mpegCrc32(section.subarray(0, body.length));
  section.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], body.length);
  return section;
}

interface ParsedPmt {
  readonly program: Required<PmtProgram>;
  readonly streams: Required<PmtStream>[];
}

function sectionEnd(section: Uint8Array): number {
  return 3 + (((section[1]! & 0x0f) << 8) | section[2]!);
}

function parsePmt(section: Uint8Array): ParsedPmt | null {
  if (section[0] !== 0x02 || section.length < 16) return null;
  const end = sectionEnd(section);
  if (end > section.length || mpegCrc32(section.subarray(0, end)) !== 0) return null;
  const programInfoLength = ((section[10]! & 0x0f) << 8) | section[11]!;
  const streams: Required<PmtStream>[] = [];
  for (let o = 12 + programInfoLength; o + 5 <= end - 4; ) {
    const esInfo = ((section[o + 3]! & 0x0f) << 8) | section[o + 4]!;
    streams.push({ streamType: section[o]!, pid: ((section[o + 1]! & 0x1f) << 8) | section[o + 2]!, descriptors: section.slice(o + 5, o + 5 + esInfo) });
    o += 5 + esInfo;
  }
  return {
    program: {
      programNumber: (section[3]! << 8) | section[4]!,
      version: (section[5]! >> 1) & 0x1f,
      pcrPid: ((section[8]! & 0x1f) << 8) | section[9]!,
      programInfo: section.slice(12, 12 + programInfoLength),
    },
    streams,
  };
}

/** Packets of one PES (or PSI section) being collected on a PID. */
interface Pending {
  /** The source packet number of the first packet: every packet made from this unit is assigned it (ruling L-R4). */
  readonly spn: number;
  readonly packets: Uint8Array[];
  readonly chunks: Uint8Array[];
  size: number;
  /** PES: 6 + PES_packet_length (0 when unbounded). PSI: the section's length once known (0 before). */
  expected: number;
}

export interface KeptStreamsOptions {
  /** The clip's PMT PIDs (CLPI program_map_PID); default 0x0100. Given, not learned from the PAT, so a run's start doesn't matter. */
  readonly pmtPids?: readonly number[];
  /**
   * The primary video as the level carries it (the re-encode keeps the PID; its stream_type is the level's, 0x1B or
   * 0x24). It is listed in the regenerated PMT; its packets are not passed (the re-muxer adds the encode's).
   */
  readonly video?: { readonly pid: number; readonly streamType: number };
}

/** A kept packet and the source packet number that assigns it to an EP interval (ruling L-R4). */
export interface KeptPacket {
  readonly spn: number;
  readonly bytes: Uint8Array;
}

/**
 * Picks a clip's packets for a level. Its output for a packet depends only on the packets from the start of that
 * packet's PES (or PSI section), never on where the run began, so interval k's packets are byte-identical whether the
 * run started at the clip's start or at k (ruling L-R4):
 *
 * - Each kept packet carries an assigning SPN: a packet on an unfiltered PID its own; every packet made from a filtered
 *   PES (changed or not) or a PMT section the SPN of that unit's first packet. A unit belongs to the interval holding it.
 * - A unit whose first packet came before the run's first packet is discarded (its tail is dropped), as it belongs to an
 *   earlier interval, which a run started there produces whole. Unfiltered PIDs pass their packets regardless.
 * - The PIDs in `keepPids` pass bit-exact. A PID with a core filter is collected per PES and filtered: an unchanged PES
 *   passes as its original packets, bit-exact; a shrunk one is re-packetized onto the same PID, the packets taking the
 *   original packets' TP_extra_headers in order (the first keeps its ATS) and continuity counters running on from the
 *   first original packet's. So counters are continuous within a PES, and jump only at a PES start where packets were
 *   dropped, which loses nothing for PES of declared length (all Blu-ray audio).
 * - The PAT passes. A PMT is regenerated (`pmtFor`) with only the kept streams, the core filters' streams at their core
 *   coding and the level's video, its counters running on from the original first packet's.
 * - Everything else, nulls included, is dropped.
 *
 * A filtered PES is returned when its last packet arrives, so it can come after packets assigned to a later interval;
 * call `flush()` at the end of the input for one still open.
 */
export class KeptStreams {
  private readonly pmtPids: ReadonlySet<number>;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly keepPids: Set<number>,
    private readonly coreFilters: Map<number, PesCoreFilter>,
    private readonly options: KeptStreamsOptions = {},
  ) {
    this.pmtPids = new Set(options.pmtPids ?? [BD_PMT_PID]);
  }

  /** The kept packets for one 192-byte source packet at `spn`: possibly none, possibly a whole rebuilt PES. */
  filter(packet: Uint8Array, spn: number): KeptPacket[] {
    const ts = parseSourcePacket(packet, 0);
    if (!ts) return [];
    if (ts.pid === PAT_PID) return [{ spn, bytes: packet }];
    if (this.pmtPids.has(ts.pid)) return this.collectPsi(ts.pid, packet, spn, ts.payloadUnitStart, ts.hasPayload, ts.payload);
    if (this.coreFilters.has(ts.pid)) return this.collectPes(ts.pid, packet, spn, ts.payloadUnitStart, ts.hasPayload, ts.payload);
    return this.keepPids.has(ts.pid) ? [{ spn, bytes: packet }] : [];
  }

  /** The PES still open on each filtered PID: an unbounded one is complete; a declared one cut short is dropped. */
  flush(): KeptPacket[] {
    const out: KeptPacket[] = [];
    for (const [pid, p] of this.pending) if (this.coreFilters.has(pid) && p.expected === 0) out.push(...this.finishPes(pid, p));
    this.pending.clear();
    return out;
  }

  private collectPes(pid: number, packet: Uint8Array, spn: number, start: boolean, hasPayload: boolean, payload: Uint8Array): KeptPacket[] {
    // An adaptation-only packet carries no audio, and its place relative to a held PES can't be kept: drop it.
    if (!hasPayload) return [];
    const out: KeptPacket[] = [];
    let p = this.pending.get(pid);
    if (start) {
      if (p && p.expected === 0) out.push(...this.finishPes(pid, p));
      const declared = payload.length >= 6 ? (payload[4]! << 8) | payload[5]! : 0;
      p = { spn, packets: [], chunks: [], size: 0, expected: declared > 0 ? 6 + declared : 0 };
      this.pending.set(pid, p);
    } else if (!p) {
      return out; // the tail of a PES that began before this run: it belongs to an earlier interval
    }
    p.packets.push(packet);
    p.chunks.push(payload);
    p.size += payload.length;
    if (p.expected !== 0 && p.size >= p.expected) {
      this.pending.delete(pid);
      out.push(...this.finishPes(pid, p));
    }
    return out;
  }

  private finishPes(pid: number, p: Pending): KeptPacket[] {
    let pes = concat(p.chunks);
    if (p.expected !== 0) pes = pes.subarray(0, p.expected);
    const kept = this.coreFilters.get(pid)!.push(pes);
    if (!kept) return [];
    const bytes = kept === pes ? p.packets : this.packetize(pid, kept, p.packets);
    return bytes.map((b) => ({ spn: p.spn, bytes: b }));
  }

  private collectPsi(pid: number, packet: Uint8Array, spn: number, start: boolean, hasPayload: boolean, payload: Uint8Array): KeptPacket[] {
    if (!hasPayload) return [];
    let p = this.pending.get(pid);
    if (start) {
      p = { spn, packets: [], chunks: [], size: 0, expected: 0 };
      this.pending.set(pid, p);
      payload = payload.subarray(1 + payload[0]!);
    } else if (!p) {
      return [];
    }
    p.packets.push(packet);
    p.chunks.push(payload);
    p.size += payload.length;
    const head = p.chunks[0]!;
    if (p.expected === 0 && head.length >= 3) p.expected = sectionEnd(head);
    if (p.expected === 0 || p.size < p.expected) return [];
    this.pending.delete(pid);
    const pmt = parsePmt(concat(p.chunks).subarray(0, p.expected));
    if (!pmt) return [];
    const section = pmtFor(this.keptPmtStreams(pmt.streams), pmt.program);
    const withPointer = new Uint8Array(1 + section.length);
    withPointer.set(section, 1);
    return this.packetize(pid, withPointer, p.packets, 0xff).map((b) => ({ spn: p.spn, bytes: b }));
  }

  /** The original PMT's streams a level keeps, in their order; a stream whose coding changes loses its descriptors. */
  private keptPmtStreams(original: readonly Required<PmtStream>[]): PmtStream[] {
    const video = this.options.video;
    const out: PmtStream[] = [];
    if (video && !original.some((s) => s.pid === video.pid)) out.push(video);
    for (const s of original) {
      let streamType: number;
      if (video && s.pid === video.pid) streamType = video.streamType;
      else if (this.coreFilters.has(s.pid)) streamType = coreCoding(s.streamType);
      else if (this.keepPids.has(s.pid)) streamType = s.streamType;
      else continue;
      out.push(streamType === s.streamType ? s : { pid: s.pid, streamType });
    }
    return out;
  }

  /**
   * `data` on `pid` from a unit start: full packets of 184 bytes, the last stuffed (PES: adaptation field; PSI: `fill`
   * bytes after the section). Each takes the TP_extra_header of the original packet at its place (the last one's past them),
   * and continuity counters run on from the first original packet's.
   */
  private packetize(pid: number, data: Uint8Array, originals: readonly Uint8Array[], fill?: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    const firstCc = originals[0]![7]! & 0x0f;
    for (let at = 0, i = 0; at < data.length; i++) {
      const take = Math.min(TS_PAYLOAD, data.length - at);
      const p = new Uint8Array(SOURCE_PACKET_SIZE);
      p.set(originals[Math.min(i, originals.length - 1)]!.subarray(0, 4));
      p[4] = 0x47;
      p[5] = (at === 0 ? 0x40 : 0) | (pid >> 8);
      p[6] = pid & 0xff;
      const cc = (firstCc + i) & 0x0f;
      if (take < TS_PAYLOAD && fill === undefined) {
        const af = TS_PAYLOAD - 1 - take;
        p[7] = 0x30 | cc;
        p[8] = af;
        if (af > 0) {
          p[9] = 0x00;
          p.fill(0xff, 10, 9 + af);
        }
        p.set(data.subarray(at, at + take), 9 + af);
      } else {
        p[7] = 0x10 | cc;
        p.set(data.subarray(at, at + take), 8);
        if (fill !== undefined) p.fill(fill, 8 + take);
      }
      out.push(p);
      at += take;
    }
    return out;
  }
}
