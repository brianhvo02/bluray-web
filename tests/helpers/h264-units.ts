/** High profile, level 4.0 SPS header bytes (enough for codec-string derivation). */
export const TEST_SPS = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40]);
const TEST_PPS = [0x68, 0xeb, 0xe3, 0xcb];
const AUD = [0x09, 0xf0];
const RECOVERY_SEI = [0x06, 0x06, 0x01, 0x84, 0x80];
const IDR_SLICE = [0x65, 0x88, 0x84, 0x00, 0x33];
const NON_IDR_SLICE = [0x41, 0x9a, 0x02, 0x11];
const MVC_PREFIX = [0x0e, 0x01, 0x02];
const MVC_SLICE = [0x14, 0x01, 0x02, 0x03];

export interface AvcAuOptions {
  idr?: boolean;
  recovery?: boolean;
  sps?: boolean;
  mvc?: boolean;
  /** Extra slice payload bytes, to make units larger than one TS packet. */
  fill?: number;
}

export function avcAu(opts: AvcAuOptions = {}): Uint8Array<ArrayBuffer> {
  const nals: number[][] = [AUD];
  if (opts.sps ?? opts.idr) nals.push(Array.from(TEST_SPS), TEST_PPS);
  if (opts.recovery) nals.push(RECOVERY_SEI);
  if (opts.mvc) nals.push(MVC_PREFIX);
  nals.push([...(opts.idr ? IDR_SLICE : NON_IDR_SLICE), ...new Array<number>(opts.fill ?? 0).fill(0x55)]);
  if (opts.mvc) nals.push(MVC_SLICE);
  const bytes: number[] = [];
  for (const nal of nals) bytes.push(0, 0, 0, 1, ...nal);
  return new Uint8Array(bytes);
}
