/*
 * Writes a playlist (.mpls) for a quality level. The structure follows how libbluray reads it
 * (src/libbluray/bdnav/mpls_parse.c: _parse_playlist, _parse_playitem, _parse_stn, _parse_stream)
 * and how src/engine/bdmv/mpls-parser.ts ports that; everything but the STN tables is copied
 * byte for byte.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { setVideoAttrs } from './clpi-writer';
import { BeWriter, readU16, readU32, rebuildSections, sectionBytes } from './sections';

/** Header offsets of the PlayList, PlayListMark and ExtensionData start addresses. */
const LIST_AT = 8;
const MARK_AT = 12;
const EXTENSION_AT = 16;
/** clip_id, codec_id, flags, stc_id, in, out, UO mask, random access, still mode and time. */
const PLAY_ITEM_FIXED_BYTES = 32;

export interface VideoAttrs {
  readonly newCoding: number;
  readonly newFormat: number;
  readonly newRate: number;
}

/**
 * The playlist at a level: in every play item's STN table, only the chosen primary audio stays
 * (`audioStreamNumber` is 1-based, as PSR1), secondary audio, secondary video and Dolby Vision
 * enhancement layers are gone, and the primary video's coding, format and rate are set. PG,
 * PiP PG and IG entries, sub paths, marks and extension data are copied.
 */
export function rewriteMpls(original: Uint8Array, keep: { audioStreamNumber: number }, video: VideoAttrs): Uint8Array {
  const listAt = readU32(original, LIST_AT);
  const list = sectionBytes(original, listAt);
  const itemCount = readU16(list, 6);
  const w = new BeWriter();
  w.bytes(list.subarray(0, 10)); // length (patched), reserved, item and sub path counts
  let at = 10;
  for (let i = 0; i < itemCount; i++) {
    const end = at + 2 + readU16(list, at);
    w.bytes(rewritePlayItem(list.subarray(at, end), keep.audioStreamNumber, video, i));
    at = end;
  }
  w.bytes(list.subarray(at)); // sub paths
  const newList = w.toBytes();
  const length = newList.length - 4;
  newList.set([length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff], 0);
  return rebuildSections(original, [LIST_AT, MARK_AT, EXTENSION_AT], new Map([[LIST_AT, newList]]));
}

function rewritePlayItem(item: Uint8Array, audioStreamNumber: number, video: VideoAttrs, index: number): Uint8Array {
  let stnAt = 2 + PLAY_ITEM_FIXED_BYTES;
  const isMultiAngle = (item[2 + 10]! & 0x10) !== 0; // bit 11 of the 16 bits after codec_id
  if (isMultiAngle) {
    const angleCount = Math.max(1, item[stnAt]!);
    stnAt += 2 + 10 * (angleCount - 1);
  }
  const stnEnd = stnAt + 2 + readU16(item, stnAt);
  if (stnEnd > item.length) throw new Error(`levels: play item ${index}'s STN runs past the item`);
  const w = new BeWriter();
  w.u16(0).bytes(item.subarray(2, stnAt));
  w.bytes(rewriteStn(item.subarray(stnAt, stnEnd), audioStreamNumber, video, index));
  w.bytes(item.subarray(stnEnd));
  const out = w.toBytes();
  const length = out.length - 2;
  out[0] = length >>> 8;
  out[1] = length & 0xff;
  return out;
}

function rewriteStn(stn: Uint8Array, audioStreamNumber: number, video: VideoAttrs, index: number): Uint8Array {
  const [videoCount, audioCount, pgCount, igCount, , , pipPgCount] = stn.subarray(4, 11);
  if (audioStreamNumber < 1 || audioStreamNumber > audioCount!) {
    throw new Error(`levels: play item ${index} has no audio stream ${audioStreamNumber} (it has ${audioCount})`);
  }
  let at = 16; // length, 2 reserved, 8 counts, 4 reserved
  const take = (): Uint8Array => {
    const start = at;
    at += 1 + stn[at]!; // stream entry
    at += 1 + stn[at]!; // coding attributes
    if (at > stn.length) throw new Error(`levels: play item ${index}'s STN entry runs past the table`);
    return stn.subarray(start, at);
  };
  const videos = Array.from({ length: videoCount! }, () => {
    const entry = take().slice();
    const attrAt = 1 + entry[0]! + 1;
    setVideoAttrs(entry.subarray(attrAt), video, false);
    return entry;
  });
  const audio = Array.from({ length: audioCount! }, take)[audioStreamNumber - 1]!;
  const graphics = Array.from({ length: pgCount! + pipPgCount! + igCount! }, take); // PG, PiP PG, IG

  const w = new BeWriter();
  w.u16(0).bytes(stn.subarray(2, 4));
  w.u8(videoCount!).u8(1).u8(pgCount!).u8(igCount!).u8(0).u8(0).u8(pipPgCount!).u8(0); // no secondary audio, secondary video or DV
  w.bytes(stn.subarray(12, 16));
  for (const e of [...videos, audio, ...graphics]) w.bytes(e);
  const out = w.toBytes();
  const length = out.length - 2;
  out[0] = length >>> 8;
  out[1] = length & 0xff;
  return out;
}
