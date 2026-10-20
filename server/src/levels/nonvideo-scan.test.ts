import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseClpi } from '../../../src/engine/bdmv/clpi-parser';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
import { KeptStreams, PesCoreFilter } from './audio-core';
import { LEVELS, planClip, videoEpMap } from './levels';
import { FileNonVideoStore, NON_VIDEO_SCAN_VERSION, nonVideoBytes, scanNonVideo, type NonVideoKey } from './nonvideo-scan';
import { IntervalCollector } from './remux';

const PACKET = 192;
const fixture = (disc: string): string => join(import.meta.dirname, '../../../fixtures/synthetic', disc, 'BDMV');

/** A clip reader over bytes, in chunks that cut packets apart. */
const readerOf = (bytes: Uint8Array) => (from: number, to?: number) => {
  const chunks: Buffer[] = [];
  for (let at = from; at < (to ?? bytes.length); at += 100_003) chunks.push(Buffer.from(bytes.subarray(at, Math.min(to ?? bytes.length, at + 100_003))));
  return Readable.from(chunks);
};

describe('scanNonVideo', { timeout: 30_000 }, () => {
  for (const c of [
    { disc: 'disc-levels', audio: 0x1100, coding: CodingType.TRUEHD, graphics: [0x1200, 0x1201] },
    { disc: 'disc-mpeg2', audio: 0x1100, coding: CodingType.AC3, graphics: [] },
  ]) {
    it(`counts per interval exactly what the re-mux keeps besides the video (${c.disc})`, async () => {
      const m2ts = new Uint8Array(readFileSync(join(fixture(c.disc), 'STREAM/00001.m2ts')));
      const clpi = parseClpi(readFileSync(join(fixture(c.disc), 'CLIPINF/00001.clpi')));
      const video = videoEpMap(clpi)!.pid;
      const { intervals } = planClip(clpi, LEVELS['phone-720'], 0);
      const scan = await scanNonVideo(readerOf(m2ts), clpi, video, intervals);

      // The re-mux's own collection, as a level keeping that audio builds it (`clipRunPlan`).
      const filters = new Map(c.coding === CodingType.TRUEHD ? [[c.audio, new PesCoreFilter(c.coding)]] : []);
      const keep = new Set([0, ...c.graphics, ...(c.coding === CodingType.TRUEHD ? [] : [c.audio])]);
      const pmtPids = [...new Set(clpi.programs.map((p) => p.programMapPid))];
      const streams = new KeptStreams(keep, filters, { pmtPids, video: { pid: video, streamType: CodingType.AVC } });
      const stcs = clpi.atcSequences.flatMap((a) => a.stc);
      const collector = new IntervalCollector(streams, { videoPid: video, pcrPid: stcs[0]!.pcrPid, intervals, stcStarts: stcs.map((s) => s.spnStcStart) });
      for (let spn = 0; spn * PACKET < m2ts.length; spn++) collector.push(m2ts.subarray(spn * PACKET, (spn + 1) * PACKET), spn);
      collector.finish();
      const expected = intervals.map((iv) => collector.take(iv).kept.length * PACKET);

      expect(nonVideoBytes(scan, c.audio)).toEqual(expected);
      expect(expected.some((n) => n > 0)).toBe(true);
      // Without audio, only the PSI and graphics.
      const none = nonVideoBytes(scan, null);
      none.forEach((n, i) => expect(n).toBeLessThanOrEqual(expected[i]!));
      expect(none.reduce((a, b) => a + b, 0)).toBeLessThan(expected.reduce((a, b) => a + b, 0));
    });
  }

  it('stops when its signal is aborted', async () => {
    const m2ts = new Uint8Array(readFileSync(join(fixture('disc-levels'), 'STREAM/00001.m2ts')));
    const clpi = parseClpi(readFileSync(join(fixture('disc-levels'), 'CLIPINF/00001.clpi')));
    const stop = new AbortController();
    stop.abort();
    await expect(scanNonVideo(readerOf(m2ts), clpi, 0x1011, planClip(clpi, LEVELS['phone-720'], 0).intervals, stop.signal)).rejects.toThrow(/stopped/);
  });
});

describe('FileNonVideoStore', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const key = (over: Partial<NonVideoKey> = {}): NonVideoKey => ({
    discId: 'abc123',
    clipId: '00001',
    size: 6144 * 3,
    mtimeMs: 1_700_000_000_000,
    intervals: [{ srcSpnStart: 0 }, { srcSpnStart: 40 }],
    ...over,
  });
  const scan = { base: [3, 1], graphics: [0, 5], audio: { '4352': [10, 12] } };

  it('keeps a scan for the same clip, size, mtime and intervals, and nothing for another', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nonvideo-'));
    const store = new FileNonVideoStore(dir);
    expect(await store.get(key())).toBeNull();
    await store.put(key(), scan);
    expect(await store.get(key())).toEqual(scan);
    expect(await new FileNonVideoStore(dir).get(key())).toEqual(scan); // after a restart
    expect(await store.get(key({ size: 6144 }))).toBeNull();
    expect(await store.get(key({ mtimeMs: 1 }))).toBeNull();
    expect(await store.get(key({ intervals: [{ srcSpnStart: 0 }, { srcSpnStart: 41 }] }))).toBeNull();
    expect(await store.get(key({ clipId: '00002' }))).toBeNull();
  });

  it('reads a damaged or older file as no scan, and refuses ids it could not name a file by', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nonvideo-'));
    const store = new FileNonVideoStore(dir);
    await store.put(key(), scan);
    const file = join(dir, 'abc123', '00001.json');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { version: number };
    writeFileSync(file, JSON.stringify({ ...stored, version: NON_VIDEO_SCAN_VERSION + 1 }));
    expect(await store.get(key())).toBeNull();
    writeFileSync(file, '{"version":');
    expect(await store.get(key())).toBeNull();
    writeFileSync(file, JSON.stringify({ ...stored, scan: { ...scan, base: [3] } }));
    expect(await store.get(key())).toBeNull();
    await store.put(key({ discId: '../x' }), scan);
    expect(await store.get(key({ discId: '../x' }))).toBeNull();
  });
});
