import { ByteWriter } from './byte-writer';

export interface BdjoAppSpec {
  readonly controlCode: 1 | 2; // 1 autostart, 2 present
  readonly orgId: number;
  readonly appId: number;
  readonly name: string;
  readonly baseDir: string; // "00000"
  readonly classpathExtension?: string;
  readonly initialClass: string;
  readonly params?: readonly string[];
}

export interface BdjoSpec {
  readonly version?: '0100' | '0200' | '0300';
  readonly jars: readonly string[]; // app cache items, type 1 (JAR), lang "*.*"
  readonly accessToAll?: boolean; // default true, num_pl 0
  readonly playlists?: readonly string[];
  readonly autostartFirstPlaylist?: boolean;
  readonly apps: readonly BdjoAppSpec[];
  readonly keyInterest?: number; // 32-bit key interest table, top 11 bits used
  readonly fileAccess?: string; // default "."
}

/** A string that is a length byte, the bytes, and one pad byte when the length is even (libbluray `_read_app_string`). */
function appString(w: ByteWriter, s: string): void {
  if (s.length > 255) throw new Error(`BDJO string too long: ${s}`);
  w.u8(s.length).ascii(s);
  if (s.length % 2 === 0) w.u8(0);
}

function writeApp(w: ByteWriter, app: BdjoAppSpec): void {
  w.u8(app.controlCode);
  w.bits(4, 1).bits(4, 0); // application type 1 (BD-J), reserved
  w.u32(app.orgId).u16(app.appId);
  w.u16(0); // 80 skipped bits: 2 reserved bytes, the descriptor length, 4 reserved bytes
  const lengthAt = w.position;
  w.u32(0).u32(0);
  // application descriptor (the length counts from here)
  const descriptorStart = w.position;
  w.bits(4, 1).bits(12, 0); // one profile
  w.u16(2).u8(1).u8(0).u8(0).u8(0); // profile 2, version 1.0.0, reserved
  w.u8(1); // priority
  w.bits(2, 3).bits(2, 1).bits(4, 0); // binding 3, visibility 1
  const nameBytes = 3 + 1 + app.name.length;
  w.u16(nameBytes).ascii('eng').u8(app.name.length).ascii(app.name);
  if (nameBytes % 2 === 1) w.u8(0);
  appString(w, ''); // icon locator
  w.u16(0); // icon flags
  appString(w, app.baseDir);
  appString(w, app.classpathExtension ?? '');
  appString(w, app.initialClass);
  const params = app.params ?? [];
  const paramBytes = params.reduce((n, p) => n + 1 + p.length, 0);
  if (paramBytes > 255) throw new Error('BDJO parameters too long');
  w.u8(paramBytes);
  for (const p of params) w.u8(p.length).ascii(p);
  if (paramBytes % 2 === 0) w.u8(0);
  // the length field sits 4 bytes before descriptorStart and counts the 4 reserved bytes after it
  w.patchU32(lengthAt, w.position - descriptorStart + 4);
}

/** Builds a .bdjo file, the inverse of libbluray's `bdjo_parse.c`. */
export function buildBdjo(spec: BdjoSpec): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  w.ascii('BDJO').ascii(spec.version ?? '0200');
  const addressesAt = w.position;
  w.zeros(40); // section start addresses, patched below

  const sections: number[] = [];

  // terminal info
  sections.push(w.position);
  w.u32(10).ascii('*****');
  w.bits(4, 6).bits(1, 0).bits(1, 0).bits(34, 0); // HAVi configuration 6 (1920x1080), masks off, padding

  // application cache info
  sections.push(w.position);
  w.u32(2 + 12 * spec.jars.length).u8(spec.jars.length).u8(0);
  for (const jar of spec.jars) {
    w.u8(1).ascii(jar.padEnd(5, '0').slice(0, 5)).ascii('*.*').zeros(3);
  }

  // accessible playlists
  sections.push(w.position);
  const playlists = spec.playlists ?? [];
  w.u32(4 + 6 * playlists.length);
  w.bits(11, playlists.length).bits(1, spec.accessToAll === false ? 0 : 1).bits(1, spec.autostartFirstPlaylist ? 1 : 0).bits(19, 0);
  for (const pl of playlists) w.ascii(pl.padEnd(5, '0').slice(0, 5)).u8(0);

  // application management table
  sections.push(w.position);
  const tableLengthAt = w.position;
  w.u32(0).u8(spec.apps.length).u8(0);
  for (const app of spec.apps) writeApp(w, app);
  w.patchU32(tableLengthAt, w.position - tableLengthAt - 4);

  // key interest table (the top 11 bits), then file access info
  sections.push(w.position);
  w.u32(spec.keyInterest ?? 0);
  sections.push(w.position);
  const fileAccess = spec.fileAccess ?? '.';
  w.u16(fileAccess.length).ascii(fileAccess);
  if (fileAccess.length % 2 === 1) w.u8(0);

  sections.forEach((at, i) => w.patchU32(addressesAt + 4 * i, at));
  return w.toBytes();
}
