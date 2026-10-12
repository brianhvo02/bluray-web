import { CodingType, isAudioCoding, isVideoCoding } from '../../src/engine/bdmv/stream-types';
import { ByteWriter } from './byte-writer';

export type IndexObjectSpec =
  | { kind: 'hdmv'; movieObjectId: number; playbackType?: number }
  | { kind: 'bdj'; name: string; playbackType?: number };

export interface IndexSpec {
  firstPlay: IndexObjectSpec;
  topMenu: IndexObjectSpec;
  titles: IndexObjectSpec[];
}

export function buildIndex(spec: IndexSpec): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  w.ascii('INDX').ascii('0200');
  const indexesStartAt = w.position;
  w.u32(0); // indexes_start_address (patched)
  w.u32(0); // extension_data_start_address
  w.zeros(24);
  w.u32(34).zeros(34); // AppInfoBDMV
  w.patchU32(indexesStartAt, w.position);
  const lengthAt = w.position;
  w.u32(0);
  writeIndexObject(w, spec.firstPlay, false);
  writeIndexObject(w, spec.topMenu, false);
  w.u16(spec.titles.length);
  for (const title of spec.titles) writeIndexObject(w, title, true);
  w.patchU32(lengthAt, w.position - lengthAt - 4);
  return w.toBytes();
}

function writeIndexObject(w: ByteWriter, o: IndexObjectSpec, isTitle: boolean): void {
  w.bits(2, o.kind === 'hdmv' ? 1 : 2);
  if (isTitle) w.bits(2, 0).bits(28, 0);
  else w.bits(30, 0);
  w.bits(2, o.playbackType ?? 0).bits(14, 0);
  if (o.kind === 'hdmv') w.u16(o.movieObjectId).u32(0);
  else w.ascii(o.name.padEnd(5, '0').slice(0, 5)).u8(0);
}

// Silence unused-import errors until later tasks add MPLS/CLPI builders that use these.
void CodingType;
void isAudioCoding;
void isVideoCoding;
