import { spawnSync, type spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClpi } from '../../../src/engine/bdmv/clpi-parser';
import { parseMpls } from '../../../src/engine/bdmv/mpls-parser';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
import { analyzeAvc } from '../../../src/engine/decode/h264';
import type { ByteSource } from '../../../src/engine/disc/byte-source';
import type { DiscManifest } from '../../../src/engine/disc/nas-api';
import { M2tsReader } from '../../../src/engine/demux/m2ts-reader';
import { PesAssembler, type PesPacket } from '../../../src/engine/demux/pes-assembler';
import { parseSourcePacket } from '../../../src/engine/demux/ts-packet';
import { readIsoTree } from '../iso';
import { nominalAudioBps } from './audio-core';
import { Capacity } from './capacity';
import type { Clock } from './clip-run';
import { rewriteClpi } from './clpi-writer';
import { x264Backend, type EncoderBackend } from './encoder';
import {
  ENCODER_IDLE_MS,
  LevelService,
  READ_AHEAD_FILM_MS,
  READ_WAIT_MS,
  firstAudioBps,
  folderDiscSource,
  isoDiscSource,
  viewingIdOf,
  type LevelDiscSource,
} from './level-service';
import { keptAudioFor, levelDefFor, planClip, videoAttrsFor } from './levels';
import { rewriteMpls } from './mpls-writer';
import { SegmentCache } from './segment-cache';

const SYNTHETIC = join(import.meta.dirname, '../../../fixtures/synthetic');
const DISC_DIR = join(SYNTHETIC, 'disc-levels');
const DISC_ID = 'lvl0001';
const VIDEO = 0x1011;
const TRUEHD = 0x1100;
const COMMENTARY = 0x1101;
const PG = [0x1200, 0x1201];
const PIP = 0x1b00;
const CLPI_PATH = 'BDMV/CLIPINF/00001.CLPI';
const MPLS_PATH = 'BDMV/PLAYLIST/00000.MPLS';
const M2TS_PATH = 'BDMV/STREAM/00001.M2TS';
const VIEWING = viewingIdOf('dev1', DISC_ID, 'h264-1080', 1);

const fixtureBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(join(DISC_DIR, 'BDMV', path)));

/** Timers that fire only when the test moves the clock. */
class ManualClock implements Clock {
  private t = 1_000_000;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
}

/** TS packets carrying one video PES at `pts90`: an IDR or a P slice, with `padding` more bytes of slice data. */
function videoPes(pts90: number, idr: boolean, padding = 0): Buffer {
  const pts = [
    0x21 | (Math.floor(pts90 / 2 ** 29) & 0x0e),
    Math.floor(pts90 / 2 ** 22) & 0xff,
    (Math.floor(pts90 / 2 ** 14) & 0xfe) | 1,
    Math.floor(pts90 / 2 ** 7) & 0xff,
    ((pts90 % 128) << 1) | 1,
  ];
  const es = [0, 0, 0, 1, idr ? 0x65 : 0x41, 0x88, 0x84, 0x21, 0xa0];
  const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...pts, ...es]), Buffer.alloc(padding, 0x5a)]);
  const packets: Buffer[] = [];
  for (let at = 0; at < pes.length; at += 184) {
    const chunk = pes.subarray(at, at + 184);
    const packet = Buffer.alloc(188, 0xff);
    packet.set([0x47, (at === 0 ? 0x40 : 0) | 0x01, 0x00]);
    if (chunk.length === 184) packet[3] = 0x10;
    else packet.set([0x30, 184 - 1 - chunk.length, 0x00], 3);
    packet.set(chunk, 188 - chunk.length);
    packets.push(packet);
  }
  return Buffer.concat(packets);
}

/**
 * A stand-in for ffmpeg: the fake backend passes the run's byte range and keyframes as its one argument, and the test
 * moves each run along by hand (`step`) or lets it finish at once (`auto`). Each step writes the next keyframe's IDR
 * and a P frame; the encoder hands an interval over once the next one's IDR is complete.
 */
class FakeFfmpeg {
  readonly runs: FakeRun[] = [];
  auto = false;
  /** Keyframe PTS whose first encode comes out this many bytes larger (an over-budget encode). */
  readonly oversize = new Map<number, number>();
  readonly backend: EncoderBackend = {
    binary: 'fake-ffmpeg',
    args: (input) => [JSON.stringify({ startByte: input.startByte, keys: input.keyframesPts90 })],
  };
  readonly spawn = ((_binary: string, args: string[]) => {
    const run = new FakeRun(JSON.parse(args[0]!) as { startByte: number; keys: number[] }, this.oversize);
    this.runs.push(run);
    if (this.auto) setImmediate(() => run.finish());
    return run.child;
  }) as unknown as typeof nodeSpawn;
}

class FakeRun {
  readonly child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    killed: false,
    kill: (): boolean => {
      this.child.killed = true;
      return true;
    },
  });
  private written = 0;
  constructor(
    readonly args: { startByte: number; keys: number[] },
    private readonly oversize: Map<number, number>,
  ) {}

  step(n = 1): void {
    for (let i = 0; i < n && this.written < this.args.keys.length; i++, this.written++) {
      const key = this.args.keys[this.written]!;
      const extra = this.oversize.get(key) ?? 0;
      this.oversize.delete(key);
      this.child.stdout.write(Buffer.concat([videoPes(key, true, extra), videoPes(key + 3003, false)]));
    }
  }

  finish(): void {
    if (this.child.killed) return;
    this.step(this.args.keys.length);
    this.child.stdout.once('end', () => setImmediate(() => this.child.emit('close', 0, null)));
    this.child.stdout.end();
  }
}

/** The level's layout as its manifest gives it: the clip's size and its EP entries (one per interval). */
function layout(manifest: DiscManifest): { size: number; spns: number[]; pts45: number[] } {
  const clpi = parseClpi(new Uint8Array(Buffer.from(manifest.inline[CLPI_PATH]!, 'base64')));
  const entries = clpi.epMaps.find((m) => m.pid === VIDEO)!.entries;
  return { size: manifest.files.find((f) => f.path === M2TS_PATH)!.size, spns: entries.map((e) => e.spn), pts45: entries.map((e) => e.pts) };
}

function intervalRange(l: ReturnType<typeof layout>, i: number): { offset: number; length: number } {
  const offset = l.spns[i]! * 192;
  const end = i + 1 < l.spns.length ? l.spns[i + 1]! * 192 : l.size;
  return { offset, length: end - offset };
}

/** PIDs in a stretch of a level's bytes, and the PTS of each video PES in it (demuxed by the engine). */
function scan(bytes: Uint8Array): { pids: Set<number>; videoPts: number[] } {
  const pids = new Set<number>();
  const videoPts: number[] = [];
  const assembler = new PesAssembler((p) => videoPts.push(p.pts!));
  for (let at = 0; at + 192 <= bytes.length; at += 192) {
    const ts = parseSourcePacket(bytes, at);
    if (!ts) continue;
    pids.add(ts.pid);
    if (ts.pid === VIDEO) assembler.push(ts);
  }
  assembler.flush();
  return { pids, videoPts };
}

let scratch: string;
let clock: ManualClock;
let fake: FakeFfmpeg;
let service: LevelService;
let capacity: Capacity;

function makeService(options: { readAheadMs?: number; discs?: (id: string) => Promise<LevelDiscSource | null>; backend?: EncoderBackend } = {}): LevelService {
  capacity = new Capacity({ h264: 190, hevc: 100 }, clock.now);
  return new LevelService({
    discs: options.discs ?? (async (id) => (id === DISC_ID ? folderDiscSource(DISC_DIR, { id, name: 'Starfall Wanderer' }) : null)),
    cache: new SegmentCache(join(scratch, 'transcode'), 1 << 30),
    capacity,
    backend: options.backend ?? fake.backend,
    ...(options.backend ? {} : { spawn: fake.spawn }),
    probe: async () => ({ interlaced: false, softPulldown: false }),
    clock,
    ...(options.readAheadMs === undefined ? {} : { readAheadMs: options.readAheadMs }),
  });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'level-service-'));
  clock = new ManualClock();
  fake = new FakeFfmpeg();
  service = makeService();
});

afterEach(() => {
  service.close();
  rmSync(scratch, { recursive: true, force: true });
});

const never = new AbortController().signal;

async function levelManifest(s: LevelService = service): Promise<DiscManifest> {
  const m = await s.manifest(DISC_ID, 'h264-1080', 1, VIEWING);
  if (!m || 'busy' in m) throw new Error('no manifest');
  return m;
}

function readInterval(l: ReturnType<typeof layout>, i: number, s: LevelService = service): Promise<Buffer | { retryAfter: 1 } | { busy: true } | null> {
  const { offset, length } = intervalRange(l, i);
  return s.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, offset, length, VIEWING, never);
}

async function bytesOf(p: Promise<Buffer | { retryAfter: 1 } | { busy: true } | null>): Promise<Buffer> {
  const got = await p;
  if (!Buffer.isBuffer(got)) throw new Error(`not bytes: ${JSON.stringify(got)}`);
  return got;
}

describe('LevelService: timings', () => {
  it('uses the spec’s windows: 120 s of film ahead, 15 s of waiting, 60 s to idle', () => {
    expect(READ_AHEAD_FILM_MS).toBe(120_000);
    expect(READ_WAIT_MS).toBe(15_000);
    expect(ENCODER_IDLE_MS).toBe(60_000);
  });
});

describe('LevelService: manifest', () => {
  it('gives the .m2ts size planClip gives, and the rewritten CLPI and MPLS, inlined', async () => {
    const original = await folderDiscSource(DISC_DIR, { id: DISC_ID, name: 'Starfall Wanderer' }).manifest();
    const manifest = await levelManifest();

    const clpiBytes = fixtureBytes('CLIPINF/00001.clpi');
    const mplsBytes = fixtureBytes('PLAYLIST/00000.mpls');
    const clpi = parseClpi(clpiBytes);
    const item = parseMpls(mplsBytes).playItems[0]!;
    const kept = keptAudioFor(item, 1)!;
    expect(kept.pid).toBe(TRUEHD);
    // The kept audio's nominal rate, from the first AC-3 core PES of the TrueHD PID, read with the engine's demuxer.
    const pes: PesPacket[] = [];
    const assembler = new PesAssembler((p) => pes.push(p));
    const m2ts = fixtureBytes('STREAM/00001.m2ts');
    for (let at = 0; at + 192 <= m2ts.length; at += 192) {
      const ts = parseSourcePacket(m2ts, at);
      if (ts?.pid === TRUEHD) assembler.push(ts);
    }
    assembler.flush();
    const core = pes.find((p) => p.streamIdExtension === 0x76)!;
    const audioBps = nominalAudioBps(CodingType.TRUEHD, core.payload);
    expect(await firstAudioBps(createReadStream(join(DISC_DIR, 'BDMV/STREAM/00001.m2ts')), TRUEHD, CodingType.TRUEHD)).toBe(audioBps);

    const def = levelDefFor('h264-1080', { height: 1080 });
    const plan = planClip(clpi, def, audioBps);
    const rate = clpi.programs[0]!.streams.find((s) => s.pid === VIDEO)!.rate;
    const clpiLevel = rewriteClpi(clpiBytes, { intervals: plan.intervals, level: def, keepPids: PG, audio: kept, videoPid: VIDEO, ...videoAttrsFor(def, rate) });
    const mplsLevel = rewriteMpls(mplsBytes, { audioStreamNumber: 1 }, videoAttrsFor(def, rate));

    const size = (path: string): number | undefined => manifest.files.find((f) => f.path === path)?.size;
    expect(size(M2TS_PATH)).toBe(plan.sizeBytes);
    expect(size(CLPI_PATH)).toBe(clpiLevel.length);
    expect(size(MPLS_PATH)).toBe(mplsLevel.length);
    expect(manifest.inline[CLPI_PATH]).toBe(Buffer.from(clpiLevel).toString('base64'));
    expect(manifest.inline[MPLS_PATH]).toBe(Buffer.from(mplsLevel).toString('base64'));
    // Everything else as the original.
    expect(manifest.files.map((f) => f.path)).toEqual(original.files.map((f) => f.path));
    expect(manifest.inline['BDMV/INDEX.BDMV']).toBe(original.inline['BDMV/INDEX.BDMV']);
    // The rewritten files read the same through the files route.
    const clpiRead = await service.read(DISC_ID, 'h264-1080', 1, CLPI_PATH, 0, clpiLevel.length, VIEWING, never);
    expect(clpiRead).toEqual(Buffer.from(clpiLevel));
  });

  it('is null for a disc that is gone, a level the disc isn’t offered at, and a bad audio number', async () => {
    expect(await service.manifest('gone', 'h264-1080', 1, VIEWING)).toBeNull();
    expect(await service.manifest(DISC_ID, 'hevc-1080-hdr', 1, VIEWING)).toBeNull(); // an SDR source
    expect(await service.manifest(DISC_ID, 'original', 1, VIEWING)).toBeNull();
    expect(await service.manifest(DISC_ID, 'h264-1080', 0, VIEWING)).toBeNull();
  });

  it('is busy when the GPU has no room, and a viewer’s new audio moves its lease', async () => {
    for (let i = 0; i < 6; i++) expect(capacity.lease(`other${i}`, 'h264', 24_000 / 1001)).toBe(true);
    expect(await service.manifest(DISC_ID, 'h264-1080', 1, VIEWING)).toEqual({ busy: true });
    capacity.release('other5');
    expect(await service.manifest(DISC_ID, 'h264-1080', 1, VIEWING)).not.toHaveProperty('busy');
    const audio2 = viewingIdOf('dev1', DISC_ID, 'h264-1080', 2);
    expect(await service.manifest(DISC_ID, 'h264-1080', 2, audio2)).not.toHaveProperty('busy');
    expect(capacity.has(VIEWING)).toBe(false);
    expect(capacity.has(audio2)).toBe(true);
  });
});

describe('LevelService: levels', () => {
  it('lists the levels of an H.264 1080p disc, gated by what the client decodes and by capacity', async () => {
    const levels = (await service.levels(DISC_ID, { hevc: false, hevc10: false, hdr: false }))!;
    expect(levels.map((l) => [l.level, l.available, l.reason])).toEqual([
      ['original', true, undefined],
      ['h264-1080', true, undefined],
      ['hevc-1080', false, 'no-hevc'],
      ['phone-720', true, undefined],
    ]);
    const manifest = await levelManifest();
    const film = (() => {
      const { intervals } = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), levelDefFor('h264-1080', { height: 1080 }), 0);
      return intervals.reduce((n, iv) => n + iv.endPts45 - iv.startPts45, 0) / 45_000;
    })();
    const size = manifest.files.find((f) => f.path === M2TS_PATH)!.size;
    expect(levels[1]!.budgetMbps).toBeCloseTo((size * 8) / film / 1e6, 1);
    expect(levels.find((l) => l.level === 'phone-720')!.budgetMbps).toBeLessThan(levels[1]!.budgetMbps);
    for (let i = 0; i < 3; i++) capacity.lease(`hevc${i}`, 'hevc', 24_000 / 1001);
    const busy = (await service.levels(DISC_ID, { hevc: true, hevc10: true, hdr: true }))!;
    expect(busy.find((l) => l.level === 'hevc-1080')).toMatchObject({ available: false, reason: 'busy' });
  });

  it('never offers the original of an MPEG-2 disc', async () => {
    const s = makeService({ discs: async (id) => folderDiscSource(join(SYNTHETIC, 'disc-mpeg2'), { id, name: 'Starfall Wanderer' }) });
    const levels = (await s.levels('mpeg2', { hevc: false, hevc10: false, hdr: false }))!;
    expect(levels[0]).toMatchObject({ level: 'original', available: false, reason: 'unplayable' });
    expect(levels.find((l) => l.level === 'h264-1080')).toMatchObject({ available: true });
    s.close();
  });
});

describe('LevelService: reads', () => {
  it('serves sequential reads in order, each interval with its own video, and runs one encoder for all of them', async () => {
    fake.auto = true;
    const l = layout(await levelManifest());
    expect(l.spns.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      const bytes = await bytesOf(readInterval(l, i));
      expect(bytes.length).toBe(intervalRange(l, i).length);
      const { pids, videoPts } = scan(bytes);
      expect(videoPts).toEqual([l.pts45[i]! * 2, l.pts45[i]! * 2 + 3003]);
      expect(pids.has(TRUEHD)).toBe(true);
    }
    expect(fake.runs.length).toBe(1);
    expect(fake.runs[0]!.args.startByte).toBe(0);
  });

  it('serves a read across intervals by continuing into the next', async () => {
    fake.auto = true;
    const l = layout(await levelManifest());
    const a = intervalRange(l, 2);
    const offset = a.offset + 1000;
    const length = a.length - 1000 + 5000;
    const bytes = await bytesOf(service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, offset, length, VIEWING, never));
    const two = await bytesOf(readInterval(l, 2));
    const three = await bytesOf(readInterval(l, 3));
    // Buffer.equals: a deep equality over megabytes is slow.
    expect(bytes.equals(Buffer.concat([two.subarray(1000), three.subarray(0, 5000)]))).toBe(true);
  });

  it('restarts at a seek far ahead of the encoder, and a read back hits the cache (Review Focus 2)', async () => {
    service.close();
    service = makeService({ readAheadMs: 3000 });
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(3); // intervals 0 and 1 are done; the encoder is at 2
    const first = await bytesOf(zero);
    const one = await bytesOf(readInterval(l, 1));
    expect(scan(one).videoPts[0]).toBe(l.pts45[1]! * 2);

    const eight = readInterval(l, 8); // 6 s of film past the encoder: a seek
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(fake.runs[0]!.child.killed).toBe(true);
    const seekRun = fake.runs[1]!;
    const plan = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), levelDefFor('h264-1080', { height: 1080 }), 0).intervals;
    expect(seekRun.args.startByte).toBe(plan[8]!.srcSpnStart * 192);
    seekRun.finish();
    expect(scan(await bytesOf(eight)).videoPts[0]).toBe(l.pts45[8]! * 2);

    const runsBefore = fake.runs.length;
    const back = await bytesOf(readInterval(l, 1)); // nothing steps the encoder: only the cache can answer
    expect(back.equals(one)).toBe(true);
    expect((await bytesOf(readInterval(l, 0))).equals(first)).toBe(true);
    // Then the encoder runs on ahead of the read, from the first interval not cached (never a cached one).
    await vi.waitFor(() => expect(fake.runs.length).toBe(runsBefore + 1));
    expect(fake.runs[runsBefore]!.args.startByte).toBe(plan[2]!.srcSpnStart * 192);
  });

  it('gives each viewing its own encoder: a viewer far ahead doesn’t restart another’s', async () => {
    service.close();
    service = makeService({ readAheadMs: 3000 });
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(2);
    await bytesOf(zero);
    const other = viewingIdOf('dev2', DISC_ID, 'h264-1080', 1);
    const { offset, length } = intervalRange(l, 8);
    const eight = service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, offset, length, other, never);
    await vi.waitFor(() => expect(fake.runs.length).toBe(2));
    expect(fake.runs[0]!.child.killed).toBe(false);
    fake.runs[1]!.finish();
    expect(scan(await bytesOf(eight)).videoPts[0]).toBe(l.pts45[8]! * 2);
    const one = readInterval(l, 1);
    fake.runs[0]!.step(1);
    expect(scan(await bytesOf(one)).videoPts[0]).toBe(l.pts45[1]! * 2);
  });

  it('waits for an interval the running encoder will reach soon, without a restart', async () => {
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(2);
    await bytesOf(zero);
    const five = readInterval(l, 5);
    fake.runs[0]!.finish();
    expect(scan(await bytesOf(five)).videoPts[0]).toBe(l.pts45[5]! * 2);
    expect(fake.runs.length).toBe(1);
  });

  it('re-encodes an interval whose encode overflows its budget before serving it (Review Focus 1)', async () => {
    fake.auto = true;
    const manifest = await levelManifest();
    const l = layout(manifest);
    const { length } = intervalRange(l, 3);
    fake.oversize.set(l.pts45[3]! * 2, length); // the first encode of interval 3 can't fit
    for (let i = 0; i < 10; i++) {
      const bytes = await bytesOf(readInterval(l, i));
      expect(bytes.length).toBe(intervalRange(l, i).length);
      expect(scan(bytes).videoPts[0]).toBe(l.pts45[i]! * 2);
    }
    // The run, then interval 3 alone again.
    const plan = planClip(parseClpi(fixtureBytes('CLIPINF/00001.clpi')), levelDefFor('h264-1080', { height: 1080 }), 0).intervals;
    expect(fake.runs.map((r) => r.args.startByte / 192)).toEqual([0, plan[3]!.srcSpnStart]);
    expect(fake.runs[1]!.args.keys).toEqual([l.pts45[3]! * 2, l.pts45[4]! * 2]);
  });

  it('answers retryAfter once a read has waited 15 s, and the encoder carries on', async () => {
    const l = layout(await levelManifest());
    let settled: unknown = null;
    const read = readInterval(l, 4).then((r) => (settled = r));
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    clock.advance(14_999);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBeNull();
    clock.advance(1);
    await read;
    expect(settled).toEqual({ retryAfter: 1 });
    expect(fake.runs[0]!.child.killed).toBe(false);
    // The retry finds the interval once the encoder made it.
    fake.runs[0]!.finish();
    expect(scan(await bytesOf(readInterval(l, 4))).videoPts[0]).toBe(l.pts45[4]! * 2);
  });

  it('stops the encoder 60 s after the last read', async () => {
    const l = layout(await levelManifest());
    const zero = readInterval(l, 0);
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.step(2);
    await bytesOf(zero);
    clock.advance(30_000);
    await bytesOf(readInterval(l, 0)); // a read, from the cache, keeps it going
    clock.advance(59_999);
    expect(fake.runs[0]!.child.killed).toBe(false);
    clock.advance(1);
    expect(fake.runs[0]!.child.killed).toBe(true);
  });

  it('is busy for a viewing with no lease when the GPU is full; a lease is touched by reads', async () => {
    const l = layout(await levelManifest());
    clock.advance(100_000);
    fake.auto = true;
    await bytesOf(readInterval(l, 0));
    clock.advance(100_000); // 200 s since the manifest, 100 s since the read: still leased
    expect(capacity.has(VIEWING)).toBe(true);
    for (let i = 0; i < 5; i++) capacity.lease(`other${i}`, 'h264', 24_000 / 1001);
    const other = viewingIdOf('dev2', DISC_ID, 'h264-1080', 1);
    const { offset, length } = intervalRange(l, 0);
    expect(await service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, offset, length, other, never)).toEqual({ busy: true });
  });

  it('refuses a range past the file', async () => {
    const l = layout(await levelManifest());
    await expect(service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, l.size - 10, 11, VIEWING, never)).rejects.toThrow(RangeError);
  });
});

describe('isoDiscSource', () => {
  it('reads an ISO disc as its folder twin', async () => {
    const abs = join(SYNTHETIC, 'disc1.iso');
    const iso = isoDiscSource(abs, await readIsoTree(abs), { id: 'disc1', name: 'Starfall Wanderer' });
    const folder = folderDiscSource(join(SYNTHETIC, 'disc1'), { id: 'disc1', name: 'Starfall Wanderer' });
    const [a, b] = await Promise.all([iso.manifest(), folder.manifest()]);
    expect(a.files).toEqual(b.files);
    const path = a.files.find((f) => f.path.endsWith('.M2TS'))!.path;
    expect(await iso.readRange(path, 1000, 5000)).toEqual(await folder.readRange(path, 1000, 5000));
    const clip = (await iso.clip(path))!;
    const chunks: Buffer[] = [];
    for await (const c of clip.read(192, 192 * 40) as AsyncIterable<Buffer>) chunks.push(c);
    expect(Buffer.concat(chunks)).toEqual(await folder.readRange(path, 192, 192 * 39));
    expect('read' in clip.input).toBe(true);
  });
});

const hasX264 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264') ?? false;
/** CI installs ffmpeg: there, a missing libx264 fails this test instead of skipping it. */
const runFfmpegTests = hasX264 || Boolean(process.env.CI);

describe.skipIf(!runFfmpegTests)('LevelService with libx264', () => {
  it('serves disc-levels at h264-1080: the manifest’s size, video at every EP entry, the kept audio and both PG, no PiP or commentary', async () => {
    service.close();
    service = new LevelService({
      discs: async (id) => (id === DISC_ID ? folderDiscSource(DISC_DIR, { id, name: 'Starfall Wanderer' }) : null),
      cache: new SegmentCache(join(scratch, 'transcode'), 1 << 30),
      capacity: new Capacity({ h264: 190, hevc: 100 }),
      backend: x264Backend,
    });
    const manifest = await levelManifest();
    const l = layout(manifest);
    let bytes: Buffer | null = null;
    for (let tries = 0; !bytes && tries < 10; tries++) {
      const got = await service.read(DISC_ID, 'h264-1080', 1, M2TS_PATH, 0, l.size, VIEWING, never);
      if (Buffer.isBuffer(got)) bytes = got;
      else expect(got).toEqual({ retryAfter: 1 });
    }
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(l.size);

    // Seek to every EP entry as the engine does, and demux: the first video there is an IDR at the entry's PTS.
    const source: ByteSource = {
      exists: (p) => p === M2TS_PATH,
      size: () => bytes!.length,
      list: () => [],
      read: async (_p, offset, length) => bytes!.subarray(offset, offset + length),
    };
    for (let i = 0; i < l.spns.length; i++) {
      const reader = new M2tsReader({ source, path: M2TS_PATH, startSpn: l.spns[i]!, pids: new Set([VIDEO]), chunkPackets: 32 });
      let first: PesPacket | undefined;
      while (!first) {
        const got = await reader.next();
        if (got === null) break;
        first = got.find((p) => p.pid === VIDEO);
      }
      reader.cancel();
      expect(first, `EP entry ${i}`).toBeDefined();
      expect(Math.floor(first!.pts! / 512)).toBe(Math.floor((l.pts45[i]! * 2) / 512));
      expect(analyzeAvc(first!.payload).idr).toBe(true);
    }

    const { pids } = scan(bytes!);
    expect(pids.has(VIDEO)).toBe(true);
    expect(pids.has(TRUEHD)).toBe(true);
    for (const pg of PG) expect(pids.has(pg)).toBe(true);
    expect(pids.has(PIP)).toBe(false);
    expect(pids.has(COMMENTARY)).toBe(false);
    // The kept audio is the TrueHD PID's AC-3 core only.
    const audio: PesPacket[] = [];
    const assembler = new PesAssembler((p) => audio.push(p));
    for (let at = 0; at + 192 <= bytes!.length; at += 192) {
      const ts = parseSourcePacket(bytes!, at);
      if (ts?.pid === TRUEHD) assembler.push(ts);
    }
    assembler.flush();
    expect(audio.length).toBeGreaterThan(0);
    expect(audio.every((p) => p.streamIdExtension === 0x76 || (p.payload[0] === 0x0b && p.payload[1] === 0x77))).toBe(true);
  }, 120_000);
});
