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
  const slice = opts.idr ? IDR_SLICE : NON_IDR_SLICE;
  const fill = opts.fill ?? 0;
  const tail: number[][] = opts.mvc ? [MVC_SLICE] : [];
  // Built with typed-array copies (not spreads) so large fills don't overflow the call stack.
  const sizes = [...nals, ...tail].reduce((sum, n) => sum + 4 + n.length, 0) + 4 + slice.length + fill;
  const out = new Uint8Array(sizes);
  let at = 0;
  const put = (nal: ArrayLike<number>): void => {
    out.set([0, 0, 0, 1], at);
    out.set(nal, at + 4);
    at += 4 + nal.length;
  };
  for (const nal of nals) put(nal);
  out.set([0, 0, 0, 1], at);
  out.set(slice, at + 4);
  out.fill(0x55, at + 4 + slice.length, at + 4 + slice.length + fill);
  at += 4 + slice.length + fill;
  for (const nal of tail) put(nal);
  return out;
}
