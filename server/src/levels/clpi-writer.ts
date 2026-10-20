/*
 * Writes a clip information file (.clpi) for a quality level. The structure follows how libbluray
 * reads it (src/libbluray/bdnav/clpi_parse.c, extdata_parse.c) and how src/engine/bdmv/clpi-parser.ts
 * ports that; sections this rewrite doesn't touch are copied byte for byte.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { parseClpi } from '../../../src/engine/bdmv/clpi-parser';
import type { EpEntry } from '../../../src/engine/bdmv/clpi-parser';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
import type { IntervalPlan, LevelDef } from './levels';
import { SOURCE_PACKET_BYTES, mapSpn, mapSpnDown } from './levels';
import { BeWriter, readU16, readU32, rebuildSections, sectionBytes, writeU32 } from './sections';

export type ClpiRewrite =
  | { readonly level: 'original' }
  | {
      readonly intervals: readonly IntervalPlan[];
      readonly level: LevelDef;
      /** The streams kept besides the video (the chosen audio, PG, IG). */
      readonly keepPids: readonly number[];
      readonly videoPid: number;
      readonly newCoding: number;
      readonly newFormat: number;
      readonly newRate: number;
    };

/** Header offsets of the section start addresses. */
const SEQUENCE_AT = 8;
const PROGRAM_AT = 12;
const CPI_AT = 16;
const CLIP_MARK_AT = 20;
const EXTENSION_AT = 24;
/** ClipInfo's number_of_source_packets (ClipInfo starts at 40). */
const NUM_SOURCE_PACKETS_AT = 56;

/**
 * The CLPI of a clip at a level: the video's EP map regenerated from the plan, dropped streams
 * gone from the program info, the video's coding, format and rate set, the source packet count
 * set, sequence and program starts moved to their new packets, and every section address fixed.
 * At `original` it is the file unchanged.
 */
export function rewriteClpi(original: Uint8Array, plan: ClpiRewrite): Uint8Array {
  if (plan.level === 'original') return original.slice();
  const { intervals, videoPid } = plan;
  if (intervals.length === 0) throw new Error('levels: an empty plan');
  const last = intervals.at(-1)!;
  const numSourcePackets = last.spnStart + last.budgetBytes / SOURCE_PACKET_BYTES;
  const keep = new Set([videoPid, ...plan.keepPids]);
  const parsed = parseClpi(original);

  const replace = new Map<number, Uint8Array | null>();
  const seqAt = readU32(original, SEQUENCE_AT);
  if (seqAt) replace.set(SEQUENCE_AT, rewriteSequenceInfo(sectionBytes(original, seqAt), intervals));
  const progAt = readU32(original, PROGRAM_AT);
  if (progAt) replace.set(PROGRAM_AT, rewriteProgramInfo(sectionBytes(original, progAt), intervals, keep, plan));
  const cpiAt = readU32(original, CPI_AT);
  if (cpiAt) {
    const cpi = sectionBytes(original, cpiAt);
    const maps = parsed.epMaps
      .filter((m) => keep.has(m.pid))
      .map((m) => ({
        pid: m.pid,
        epStreamType: m.epStreamType,
        entries:
          m.pid === videoPid
            ? planEntries(intervals, m.entries.length)
            : m.entries.map((e) => ({ pts: e.pts, spn: mapSpnDown(intervals, e.spn) })),
        flags: fineFlags(cpi, m.pid),
      }));
    replace.set(CPI_AT, writeCpi(cpi, maps));
  }
  const extAt = readU32(original, EXTENSION_AT);
  if (extAt) replace.set(EXTENSION_AT, rewriteExtension(sectionBytes(original, extAt)));

  const out = rebuildSections(original, [SEQUENCE_AT, PROGRAM_AT, CPI_AT, CLIP_MARK_AT, EXTENSION_AT], replace);
  writeU32(out, NUM_SOURCE_PACKETS_AT, numSourcePackets);
  return out;
}

function planEntries(intervals: readonly IntervalPlan[], count: number): EpEntry[] {
  if (intervals.length !== count) throw new Error(`levels: ${intervals.length} intervals for ${count} video EP entries`);
  return intervals.map((iv) => ({ pts: iv.startPts45, spn: iv.spnStart }));
}

/** SequenceInfo with each ATC and STC sequence's first packet moved to the level's layout. */
function rewriteSequenceInfo(section: Uint8Array, intervals: readonly IntervalPlan[]): Uint8Array {
  const out = section.slice();
  let at = 5;
  const atcCount = out[at++]!;
  for (let i = 0; i < atcCount; i++) {
    writeU32(out, at, mapSpn(intervals, readU32(out, at)));
    const stcCount = out[at + 4]!;
    at += 6;
    for (let j = 0; j < stcCount; j++) {
      writeU32(out, at + 2, mapSpn(intervals, readU32(out, at + 2)));
      at += 14;
    }
  }
  return out;
}

/** ProgramInfo with only the kept streams, the video's coding attributes set. */
function rewriteProgramInfo(
  section: Uint8Array,
  intervals: readonly IntervalPlan[],
  keep: ReadonlySet<number>,
  plan: { videoPid: number; newCoding: number; newFormat: number; newRate: number },
): Uint8Array {
  const w = new BeWriter();
  w.u32(0).bytes(section.subarray(4, 6)); // length, reserved
  const programCount = section[5]!;
  let at = 6;
  for (let p = 0; p < programCount; p++) {
    const streamCount = section[at + 6]!;
    w.u32(mapSpn(intervals, readU32(section, at))).u16(readU16(section, at + 4));
    const countAt = w.position;
    w.u8(0).u8(section[at + 7]!); // num_streams (patched), num_groups
    at += 8;
    let kept = 0;
    for (let s = 0; s < streamCount; s++) {
      const pid = readU16(section, at);
      const end = at + 3 + section[at + 2]!;
      if (keep.has(pid)) {
        const entry = section.slice(at, end);
        if (pid === plan.videoPid) setVideoAttrs(entry.subarray(3), plan, true);
        w.bytes(entry);
        kept++;
      }
      at = end;
    }
    w.patchU8(countAt, kept);
  }
  const out = w.toBytes();
  writeU32(out, 0, out.length - 4);
  return out;
}

/**
 * Sets coding type, format and rate in a stream's coding attributes (after its length byte). A
 * video that stops being HEVC loses the HEVC-only bits (cr_flag, dynamic range, colour space,
 * HDR10+), which are reserved for the other codings. `clpi` marks the CLPI layout, whose third
 * byte holds the aspect ratio and oc_flag ahead of cr_flag.
 */
export function setVideoAttrs(attr: Uint8Array, video: { newCoding: number; newFormat: number; newRate: number }, clpi: boolean): void {
  const wasHevc = attr[0] === CodingType.HEVC;
  attr[0] = video.newCoding;
  attr[1] = ((video.newFormat & 0x0f) << 4) | (video.newRate & 0x0f);
  if (!wasHevc || video.newCoding === CodingType.HEVC) return;
  if (clpi) {
    if (attr.length > 2) attr[2]! &= 0xfe;
    attr.fill(0, 3, Math.min(attr.length, 5));
  } else {
    attr.fill(0, 2, Math.min(attr.length, 4));
  }
}

/** The 4 leading bits (is_angle_change_point, I_end_position_offset) of each fine entry of a PID. */
function fineFlags(cpi: Uint8Array, pid: number): number[] {
  if (readU32(cpi, 0) === 0) return [];
  const epMapStart = 6;
  const pidCount = cpi[epMapStart + 1]!;
  for (let i = 0; i < pidCount; i++) {
    const h = epMapStart + 2 + 12 * i;
    if (readU16(cpi, h) !== pid) continue;
    const fineCount = readU32(cpi, h + 4) & 0x3ffff;
    const streamStart = epMapStart + readU32(cpi, h + 8);
    const fineStart = streamStart + readU32(cpi, streamStart);
    return Array.from({ length: fineCount }, (_, f) => cpi[fineStart + 4 * f]! >>> 4);
  }
  return [];
}

interface MapToWrite {
  readonly pid: number;
  readonly epStreamType: number;
  readonly entries: readonly EpEntry[];
  /** Per entry, the fine entry's leading 4 bits to keep; 0 where there is none. */
  readonly flags: readonly number[];
}

/**
 * The CPI section with these EP maps. A coarse entry opens whenever the PTS bits above the fine
 * entry's (45 kHz bit 19 up) or the SPN bits above the low 17 change, which is what libbluray's
 * reading of coarse plus fine entries recovers.
 */
function writeCpi(original: Uint8Array, maps: readonly MapToWrite[]): Uint8Array {
  const w = new BeWriter();
  w.u32(0);
  if (readU32(original, 0) === 0 && maps.length === 0) return w.toBytes();
  w.bytes(original.subarray(4, 6)); // reserved, CPI_type
  const epMapStart = w.position;
  w.u8(0).u8(maps.length);
  const groups = maps.map((m) => groupEntries(m.entries));
  const addrAt: number[] = [];
  maps.forEach((m, i) => {
    w.u16(m.pid).bits(10, 0).bits(4, m.epStreamType).bits(16, groups[i]!.length).bits(18, m.entries.length);
    addrAt.push(w.position);
    w.u32(0);
  });
  maps.forEach((m, i) => {
    const streamStart = w.position;
    w.patchU32(addrAt[i]!, streamStart - epMapStart);
    w.u32(4 + 8 * groups[i]!.length);
    for (const c of groups[i]!) {
      const e = m.entries[c]!;
      w.bits(18, c).bits(14, Math.floor(e.pts / 2 ** 18) & 0x3fff).u32(e.spn);
    }
    m.entries.forEach((e, f) => {
      w.bits(4, m.flags[f] ?? 0).bits(11, Math.floor(e.pts / 2 ** 8) & 0x7ff).bits(17, e.spn & 0x1ffff);
    });
  });
  const out = w.toBytes();
  writeU32(out, 0, out.length - 4);
  return out;
}

/** The indexes of the entries that open a coarse entry. */
function groupEntries(entries: readonly EpEntry[]): number[] {
  const starts: number[] = [];
  let key = '';
  entries.forEach((e, i) => {
    const k = `${Math.floor(e.pts / 2 ** 19)}:${Math.floor(e.spn / 0x20000)}`;
    if (k !== key) starts.push(i);
    key = k;
  });
  return starts;
}

/**
 * Extension data without the 3D entries (2.4 extent start points, 2.5 ProgramInfo SS, 2.6 CPI SS),
 * which describe the MVC dependent view every level drops; null when nothing is left. Unchanged
 * when there is nothing to drop.
 */
function rewriteExtension(section: Uint8Array): Uint8Array | null {
  const count = section[11]!;
  const entries = Array.from({ length: count }, (_, i) => {
    const at = 12 + 12 * i;
    return { id1: readU16(section, at), id2: readU16(section, at + 2), start: readU32(section, at + 4), length: readU32(section, at + 8) };
  });
  const kept = entries.filter((e) => !(e.id1 === 2 && (e.id2 === 4 || e.id2 === 5 || e.id2 === 6)));
  if (kept.length === entries.length) return section;
  if (kept.length === 0) return null;
  const table = 12 + 12 * kept.length;
  const w = new BeWriter();
  w.u32(0).u32(table).bytes(section.subarray(8, 11)).u8(kept.length);
  let dataAt = table;
  for (const e of kept) {
    w.u16(e.id1).u16(e.id2).u32(dataAt).u32(e.length);
    dataAt += e.length;
  }
  for (const e of kept) w.bytes(section.subarray(e.start, e.start + e.length));
  const out = w.toBytes();
  writeU32(out, 0, out.length - 4);
  return out;
}
