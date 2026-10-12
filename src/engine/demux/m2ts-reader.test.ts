import { describe, expect, it } from 'vitest';
import { muxM2ts, type MuxUnit } from '../../../tests/helpers/ts-muxer';
import { FileSource } from '../disc/file-source';
import { M2tsReader, type M2tsReaderOptions } from './m2ts-reader';
import type { PesPacket } from './pes-assembler';

const PATH = 'BDMV/STREAM/00001.M2TS';
const VIDEO = 0x1011;
const AUDIO = 0x1100;

function clip(withAudio: boolean): { source: FileSource; units: MuxUnit[]; unitSpns: number[]; bytes: Uint8Array<ArrayBuffer> } {
  const units: MuxUnit[] = [];
  for (let i = 0; i < 40; i++) {
    units.push({ pid: VIDEO, streamId: 0xe0, pts: 900_000 + i * 3750, payload: new Uint8Array(1000).fill(i) });
    if (withAudio) units.push({ pid: AUDIO, streamId: 0xbd, pts: 900_000 + i * 3750, payload: new Uint8Array(100).fill(i) });
  }
  const { bytes, unitSpns } = muxM2ts(units);
  return { source: new FileSource(new Map([[PATH, new Blob([bytes])]])), units, unitSpns, bytes };
}

async function readAll(opts: M2tsReaderOptions): Promise<PesPacket[]> {
  const reader = new M2tsReader(opts);
  const out: PesPacket[] = [];
  for (let batch = await reader.next(); batch !== null; batch = await reader.next()) out.push(...batch);
  return out;
}

describe('M2tsReader', () => {
  it('reads every selected PES across small chunks', async () => {
    const { source, units } = clip(true);
    const out = await readAll({ source, path: PATH, startSpn: 0, pids: new Set([VIDEO]), chunkPackets: 32 });
    expect(out.map((p) => p.pts)).toEqual(units.filter((u) => u.pid === VIDEO).map((u) => u.pts));
  });

  it('starts at the aligned unit containing startSpn and skips partial PES', async () => {
    const { source, units, unitSpns } = clip(false);
    const startSpn = unitSpns[20];
    const aligned = Math.floor(startSpn / 32) * 32;
    const out = await readAll({ source, path: PATH, startSpn, pids: new Set([VIDEO]), chunkPackets: 64 });
    const expected = units.filter((_, i) => unitSpns[i] >= aligned).map((u) => u.pts);
    expect(out.map((p) => p.pts)).toEqual(expected);
    expect(out.some((p) => p.pts === units[20].pts)).toBe(true);
  });

  it('stops at endSpn', async () => {
    const { source, units, unitSpns } = clip(false);
    const out = await readAll({ source, path: PATH, startSpn: 0, endSpn: unitSpns[10], pids: new Set([VIDEO]) });
    expect(out.map((p) => p.pts)).toEqual(units.slice(0, 10).map((u) => u.pts));
  });

  it('counts corrupt packets and keeps going', async () => {
    const { bytes, units } = clip(false);
    bytes[192 * 3 + 4] = 0x00; // break one packet inside the first PES
    const source = new FileSource(new Map([[PATH, new Blob([bytes])]]));
    const reader = new M2tsReader({ source, path: PATH, startSpn: 0, pids: new Set([VIDEO]) });
    const out: PesPacket[] = [];
    for (let batch = await reader.next(); batch !== null; batch = await reader.next()) out.push(...batch);
    expect(reader.stats.corruptPackets).toBe(1);
    expect(reader.stats.continuityErrors).toBe(1);
    expect(out.map((p) => p.pts)).toEqual(units.slice(1).map((u) => u.pts));
  });
});
