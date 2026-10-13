import { ParseError } from '../util/byte-reader';
import { joinAnnexB, splitAnnexB, unescapeRbsp } from './nal';

export interface AccessUnitInfo {
  readonly key: boolean;
  readonly idr: boolean;
  readonly sps: Uint8Array | null;
  /** The access unit to decode (MVC NAL units removed for AVC). */
  readonly data: Uint8Array;
}

const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_SPS = 7;
/** Prefix NAL, subset SPS, coded slice extension: MVC dependent-view data that a 2D decoder must not see. */
const MVC_TYPES = new Set([14, 15, 20]);
const SEI_RECOVERY_POINT = 6;

export function avcCodecString(sps: Uint8Array): string {
  if (sps.length < 4) throw new ParseError(`H.264 SPS is truncated (${sps.length} bytes)`);
  const hex = (b: number): string => b.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

export function analyzeAvc(data: Uint8Array): AccessUnitInfo {
  const nals = splitAnnexB(data);
  let idr = false;
  let recovery = false;
  let sps: Uint8Array | null = null;
  let hasMvc = false;
  for (const nal of nals) {
    const type = nal[0] & 0x1f;
    if (MVC_TYPES.has(type)) {
      hasMvc = true;
    } else if (type === NAL_IDR) {
      idr = true;
    } else if (type === NAL_SPS) {
      sps ??= nal;
    } else if (type === NAL_SEI && seiHasRecoveryPoint(nal)) {
      recovery = true;
    }
  }
  const out = hasMvc ? joinAnnexB(nals.filter((n) => !MVC_TYPES.has(n[0] & 0x1f))) : data;
  return { key: idr || recovery, idr, sps, data: out };
}

function seiHasRecoveryPoint(nal: Uint8Array): boolean {
  const rbsp = unescapeRbsp(nal.subarray(1));
  let i = 0;
  while (i < rbsp.length && rbsp[i] !== 0x80) {
    let type = 0;
    while (rbsp[i] === 0xff) {
      type += 255;
      i++;
    }
    type += rbsp[i++];
    let size = 0;
    while (rbsp[i] === 0xff) {
      size += 255;
      i++;
    }
    size += rbsp[i++];
    if (type === SEI_RECOVERY_POINT) return true;
    i += size;
  }
  return false;
}
