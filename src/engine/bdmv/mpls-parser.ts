import { ByteReader, ParseError } from '../util/byte-reader';
import { CodingType, isAudioCoding, isVideoCoding } from './stream-types';

/** Ported from libbluray bdnav/mpls_parse.c (playlist, play items, STN, marks). */
export interface StreamEntry {
  readonly pid: number;
  readonly codingType: number;
  readonly format: number;
  readonly rate: number;
  readonly lang: string;
  /** True for streams carried in a sub-path clip (stream_type 2–4); M1 plays main-path streams only. */
  readonly subPath: boolean;
}

export interface StnTable {
  readonly video: readonly StreamEntry[];
  readonly audio: readonly StreamEntry[];
  readonly pg: readonly StreamEntry[];
  readonly ig: readonly StreamEntry[];
}

export interface PlayItem {
  readonly clipId: string;
  readonly codecId: string;
  readonly connectionCondition: number;
  readonly stcId: number;
  /** 45 kHz clip time. */
  readonly inTime: number;
  /** 45 kHz clip time (exclusive). */
  readonly outTime: number;
  readonly uoMask: Uint8Array;
  readonly stillMode: number;
  readonly stillTime: number;
  readonly isMultiAngle: boolean;
  readonly angleClipIds: readonly string[];
  readonly stn: StnTable;
}

export interface PlayListMark {
  readonly type: number;
  readonly playItemRef: number;
  /** 45 kHz clip time within the referenced play item. */
  readonly time: number;
  readonly entryEsPid: number;
  readonly duration: number;
}

export interface Mpls {
  readonly version: string;
  readonly playbackType: number;
  readonly uoMask: Uint8Array;
  readonly playItems: readonly PlayItem[];
  readonly marks: readonly PlayListMark[];
}

export const MarkType = { ENTRY: 1, LINK: 2 } as const;

export function parseMpls(bytes: Uint8Array): Mpls {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'MPLS') throw new ParseError(`mpls: bad signature "${signature}"`);
  const listPos = r.u32();
  const markPos = r.u32();
  r.u32(); // extension data position

  r.seek(40);
  const appInfoLength = r.u32();
  const appInfoStart = r.position;
  r.skip(1);
  const playbackType = r.u8();
  r.skip(2);
  const uoMask = r.take(8).slice();
  r.seek(appInfoStart + appInfoLength);

  r.seek(listPos);
  r.u32(); // length
  r.skip(2);
  const itemCount = r.u16();
  r.u16(); // sub-path count
  const playItems: PlayItem[] = [];
  for (let i = 0; i < itemCount; i++) playItems.push(readPlayItem(r));

  return { version, playbackType, uoMask, playItems, marks: readMarks(r, markPos) };
}

function readPlayItem(r: ByteReader): PlayItem {
  const length = r.u16();
  const start = r.position;
  const clipId = r.ascii(5);
  const codecId = r.ascii(4);
  r.skipBits(11);
  const isMultiAngle = r.flag();
  const connectionCondition = r.bits(4);
  const stcId = r.u8();
  const inTime = r.u32();
  const outTime = r.u32();
  const uoMask = r.take(8).slice();
  r.skip(1); // random_access_flag + reserved
  const stillMode = r.u8();
  const stillTimeField = r.u16();
  const angleClipIds: string[] = [];
  if (isMultiAngle) {
    const angleCount = r.u8();
    r.skip(1);
    for (let a = 1; a < angleCount; a++) {
      angleClipIds.push(r.ascii(5));
      r.skip(4 + 1); // codec id, stc id
    }
  }
  const stn = readStn(r);
  r.seek(start + length);
  return {
    clipId,
    codecId,
    connectionCondition,
    stcId,
    inTime,
    outTime,
    uoMask,
    stillMode,
    stillTime: stillMode === 1 ? stillTimeField : 0,
    isMultiAngle,
    angleClipIds,
    stn,
  };
}

function readStn(r: ByteReader): StnTable {
  const length = r.u16();
  const start = r.position;
  r.skip(2);
  const videoCount = r.u8();
  const audioCount = r.u8();
  const pgCount = r.u8();
  const igCount = r.u8();
  r.u8(); // secondary audio count (not used by M1)
  r.u8(); // secondary video count (not used by M1)
  const pipPgCount = r.u8();
  r.skip(5); // reserved
  const readMany = (n: number): StreamEntry[] => Array.from({ length: n }, () => readStream(r));
  const video = readMany(videoCount);
  const audio = readMany(audioCount);
  const pg = readMany(pgCount);
  readMany(pipPgCount); // PiP PG entries follow the PG entries and are skipped (PiP is out of scope)
  const ig = readMany(igCount);
  r.seek(start + length);
  return { video, audio, pg, ig };
}

function readStream(r: ByteReader): StreamEntry {
  const entryLength = r.u8();
  const entryStart = r.position;
  const streamType = r.u8();
  let pid = 0;
  switch (streamType) {
    case 1:
      pid = r.u16();
      break;
    case 2:
      r.skip(2);
      pid = r.u16();
      break;
    case 3:
    case 4:
      r.skip(1);
      pid = r.u16();
      break;
    default:
      break;
  }
  r.seek(entryStart + entryLength);

  const attrLength = r.u8();
  const attrStart = r.position;
  const codingType = r.u8();
  let format = 0;
  let rate = 0;
  let lang = '';
  if (isVideoCoding(codingType)) {
    format = r.bits(4);
    rate = r.bits(4);
  } else if (isAudioCoding(codingType)) {
    format = r.bits(4);
    rate = r.bits(4);
    lang = r.ascii(3);
  } else if (codingType === CodingType.PG || codingType === CodingType.IG) {
    lang = r.ascii(3);
  } else if (codingType === CodingType.TEXT_SUBTITLE) {
    r.skip(1);
    lang = r.ascii(3);
  }
  r.seek(attrStart + attrLength);
  return { pid, codingType, format, rate, lang, subPath: streamType !== 1 };
}

function readMarks(r: ByteReader, markPos: number): PlayListMark[] {
  if (markPos === 0) return [];
  r.seek(markPos);
  r.u32(); // length
  const count = r.u16();
  const marks: PlayListMark[] = [];
  for (let i = 0; i < count; i++) {
    r.skip(1);
    const type = r.u8();
    const playItemRef = r.u16();
    const time = r.u32();
    const entryEsPid = r.u16();
    const duration = r.u32();
    marks.push({ type, playItemRef, time, entryEsPid, duration });
  }
  return marks;
}
