import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClpi } from '../../../src/engine/bdmv/clpi-parser';
import { CodingType } from '../../../src/engine/bdmv/stream-types';
import { PesAssembler, type PesPacket } from '../../../src/engine/demux/pes-assembler';
import { parseSourcePacket } from '../../../src/engine/demux/ts-packet';
import { KeptStreams, PesCoreFilter, mpegCrc32, pmtFor, type KeptPacket } from './audio-core';
import { LEVELS, planClip, type IntervalPlan } from './levels';
import { IntervalCollector, PCR_PERIOD_27, atsOf, remuxInterval, type EncodedPes, type IntervalSource, type RemuxInput } from './remux';

const PACKET = 192;
const VIDEO = 0x1011;
const fixture = (disc: string): string => join(import.meta.dirname, '../../../fixtures/synthetic', disc, 'BDMV');

function packetsOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at + PACKET <= bytes.length; at += PACKET) out.push(bytes.subarray(at, at + PACKET));
  return out;
}

const pidOf = (p: Uint8Array): number => ((p[5]! & 0x1f) << 8) | p[6]!;

function demux(packets: readonly Uint8Array[]): { pes: PesPacket[]; continuityErrors: number } {
  const pes: PesPacket[] = [];
  const assembler = new PesAssembler((p) => pes.push(p));
  for (const p of packets) {
    const ts = parseSourcePacket(p, 0);
    if (ts) assembler.push(ts);
  }
  assembler.flush();
  return { pes, continuityErrors: assembler.continuityErrors };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The whole PES on `pid`, as bytes, with the SPN of the first packet of each. */
function rawPes(packets: readonly Uint8Array[], pid: number): Array<{ spn: number; bytes: Uint8Array }> {
  const out: Array<{ spn: number; chunks: Uint8Array[] }> = [];
  packets.forEach((p, spn) => {
    const ts = parseSourcePacket(p, 0);
    if (!ts || ts.pid !== pid || !ts.hasPayload) return;
    if (ts.payloadUnitStart) out.push({ spn, chunks: [] });
    out.at(-1)?.chunks.push(ts.payload);
  });
  return out.map(({ spn, chunks }) => {
    const bytes = concat(chunks);
    const declared = (bytes[4]! << 8) | bytes[5]!;
    return { spn, bytes: declared ? bytes.subarray(0, 6 + declared) : bytes };
  });
}

/** The source's PES on `pid` whose first packet lies in the interval, parsed. */
function pesIn(packets: readonly Uint8Array[], pid: number, plan: IntervalPlan): PesPacket[] {
  const inside = rawPes(packets, pid).filter((r) => r.spn >= plan.srcSpnStart && r.spn < plan.srcSpnEnd);
  return inside.flatMap((r) => {
    const out: PesPacket[] = [];
    const a = new PesAssembler((p) => out.push(p));
    a.push({ pid, payloadUnitStart: true, continuityCounter: 0, hasPayload: true, payload: r.bytes });
    a.flush();
    return out;
  });
}

/** The source's video PES of an interval, as a stand-in for the encoder's output. */
function videoOf(packets: readonly Uint8Array[], plan: IntervalPlan): EncodedPes[] {
  return rawPes(packets, VIDEO)
    .filter((r) => r.spn >= plan.srcSpnStart && r.spn < plan.srcSpnEnd)
    .map((r) => {
      const parsed: PesPacket[] = [];
      const a = new PesAssembler((x) => parsed.push(x));
      a.push({ pid: VIDEO, payloadUnitStart: true, continuityCounter: 0, hasPayload: true, payload: r.bytes });
      a.flush();
      return { pes: r.bytes, dts90: parsed[0]!.dts ?? parsed[0]!.pts! };
    });
}

/** Runs a collector over the whole clip, in order, and takes every interval as soon as it is ready. */
function collectAll(packets: readonly Uint8Array[], intervals: readonly IntervalPlan[], streams: KeptStreams, pcrPid = 0x1001): IntervalSource[] {
  const collector = new IntervalCollector(streams, VIDEO, pcrPid);
  const out: IntervalSource[] = [];
  let next = 0;
  packets.forEach((p, spn) => {
    collector.push(p, spn);
    while (next < intervals.length && collector.ready(intervals[next]!)) out.push(collector.take(intervals[next++]!));
  });
  collector.finish();
  while (next < intervals.length) out.push(collector.take(intervals[next++]!));
  return out;
}

function inputFor(plan: IntervalPlan, source: IntervalSource, video: EncodedPes[], extra: Partial<RemuxInput> = {}): RemuxInput {
  return { plan, kept: source.kept, video, videoPid: VIDEO, videoTimeline: source.videoTimeline, pcr: null, endAts: source.endAts, ...extra };
}

function bytesOf(result: ReturnType<typeof remuxInterval>): Uint8Array {
  if (!('bytes' in result)) throw new Error(`overflow ${result.overflow}`);
  return result.bytes;
}

const strip = (p: Uint8Array): Uint8Array => p.subarray(4);

interface Case {
  readonly disc: string;
  readonly streams: () => KeptStreams;
  readonly audioPid: number;
  /** The audio PES a level keeps from the source. */
  readonly keepAudio: (p: PesPacket) => boolean;
  readonly pgPids: readonly number[];
}

const cases: Case[] = [
  {
    disc: 'disc-levels',
    streams: () =>
      new KeptStreams(new Set([0x1200, 0x1201]), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]), {
        video: { pid: VIDEO, streamType: CodingType.AVC },
      }),
    audioPid: 0x1100,
    keepAudio: (p) => p.streamIdExtension === 0x76,
    pgPids: [0x1200, 0x1201],
  },
  {
    disc: 'disc-mpeg2',
    streams: () => new KeptStreams(new Set(), new Map([[0x1100, new PesCoreFilter(CodingType.AC3)]]), { video: { pid: VIDEO, streamType: CodingType.AVC } }),
    audioPid: 0x1100,
    keepAudio: () => true,
    pgPids: [],
  },
];

for (const c of cases) {
  describe(`remuxInterval on ${c.disc}`, () => {
    const m2ts = readFileSync(join(fixture(c.disc), 'STREAM/00001.m2ts'));
    const packets = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));
    const clpi = parseClpi(readFileSync(join(fixture(c.disc), 'CLIPINF/00001.clpi')));
    const { intervals } = planClip(clpi, LEVELS['h264-1080'], 192_000);
    const sources = collectAll(packets, intervals, c.streams());
    const outputs = intervals.map((plan, k) => bytesOf(remuxInterval(inputFor(plan, sources[k]!, videoOf(packets, plan)))));

    it('fills every interval to exactly its budget, with a sync byte at 4 + 192n', () => {
      expect(intervals.length).toBeGreaterThan(3);
      intervals.forEach((plan, k) => {
        const out = outputs[k]!;
        expect(out.length).toBe(plan.budgetBytes);
        for (let at = 4; at < out.length; at += PACKET) if (out[at] !== 0x47) throw new Error(`interval ${k}: no sync byte at ${at}`);
      });
    });

    it('never lets the ATS go back within an interval', () => {
      for (const out of outputs) {
        const ats = packetsOf(out).map(atsOf);
        expect(ats.every((a, i) => i === 0 || a >= ats[i - 1]!)).toBe(true);
      }
    });

    it('gives back the video PES (same bytes and DTS), the kept audio PES and the PG PES unchanged', () => {
      intervals.forEach((plan, k) => {
        const { pes } = demux(packetsOf(outputs[k]!));
        const on = (pid: number): PesPacket[] => pes.filter((p) => p.pid === pid);
        const video = on(VIDEO);
        const sourceVideo = pesIn(packets, VIDEO, plan);
        expect(video.length).toBeGreaterThan(0);
        expect(video.map((p) => [p.pts, p.dts])).toEqual(sourceVideo.map((p) => [p.pts, p.dts]));
        expect(video.map((p) => p.payload)).toEqual(sourceVideo.map((p) => p.payload));
        const audio = pesIn(packets, c.audioPid, plan).filter(c.keepAudio);
        expect(on(c.audioPid).map((p) => [p.pts, p.streamIdExtension, p.payload])).toEqual(audio.map((p) => [p.pts, p.streamIdExtension, p.payload]));
        for (const pid of c.pgPids) expect(on(pid)).toEqual(pesIn(packets, pid, plan));
        expect(new Set(pes.map((p) => p.pid))).toEqual(new Set([VIDEO, c.audioPid, ...c.pgPids].filter((pid) => on(pid).length > 0)));
      });
    });

    it('carries every kept packet exactly once, in the order of its assigned SPN', () => {
      intervals.forEach((_, k) => {
        const kept = packetsOf(outputs[k]!).filter((p) => pidOf(p) !== VIDEO && pidOf(p) !== 0x1fff);
        const expected = sources[k]!.kept.map((x, i) => ({ x, i })).sort((a, b) => a.x.spn - b.x.spn || a.i - b.i);
        expect(kept.map(strip)).toEqual(expected.map(({ x }) => strip(x.bytes)));
      });
    });

    it('interleaves the video with the kept packets by DTS, as the source did', () => {
      for (const out of outputs) {
        const kinds = packetsOf(out).filter((p) => pidOf(p) !== 0x1fff).map((p) => (pidOf(p) === VIDEO ? 'v' : 'k'));
        const firstVideo = kinds.indexOf('v');
        const lastVideo = kinds.lastIndexOf('v');
        expect(kinds.slice(firstVideo, lastVideo).includes('k')).toBe(true);
      }
    });

    it('keeps the video PID continuous from one interval to the next, so no frame is lost at a boundary', () => {
      for (const out of outputs) {
        const ccs = packetsOf(out).filter((p) => pidOf(p) === VIDEO).map((p) => p[7]! & 0x0f);
        expect(ccs[0]).toBe(0);
        expect(ccs.at(-1)).toBe(15);
      }
      const all = demux(outputs.flatMap(packetsOf));
      const video = all.pes.filter((p) => p.pid === VIDEO);
      expect(video.map((p) => p.payload)).toEqual(demux(packets).pes.filter((p) => p.pid === VIDEO).map((p) => p.payload));
    });
  });
}

describe('remuxInterval budgets and PSI', () => {
  const m2ts = readFileSync(join(fixture('disc-levels'), 'STREAM/00001.m2ts'));
  const packets = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));
  const clpi = parseClpi(readFileSync(join(fixture('disc-levels'), 'CLIPINF/00001.clpi')));
  const { intervals } = planClip(clpi, LEVELS['h264-1080'], 192_000);
  const sources = collectAll(packets, intervals, cases[0]!.streams());

  it('reports the bytes past the budget, and no bytes, when the content does not fit (Review Focus 1)', () => {
    const plan = { ...intervals[2]!, budgetBytes: 6144 };
    const result = remuxInterval(inputFor(plan, sources[2]!, videoOf(packets, intervals[2]!)));
    expect(result).not.toHaveProperty('bytes');
    const fits = bytesOf(remuxInterval(inputFor(intervals[2]!, sources[2]!, videoOf(packets, intervals[2]!))));
    const content = packetsOf(fits).filter((p) => pidOf(p) !== 0x1fff).length * PACKET;
    expect(result).toEqual({ overflow: content - 6144 });
  });

  it('fits content of exactly the budget with no padding', () => {
    const fits = bytesOf(remuxInterval(inputFor(intervals[2]!, sources[2]!, videoOf(packets, intervals[2]!))));
    const content = packetsOf(fits).filter((p) => pidOf(p) !== 0x1fff).length * PACKET;
    const exact = bytesOf(remuxInterval(inputFor({ ...intervals[2]!, budgetBytes: content }, sources[2]!, videoOf(packets, intervals[2]!))));
    expect(packetsOf(exact).some((p) => pidOf(p) === 0x1fff)).toBe(false);
  });

  it("puts interval 0's leading PAT and PMT before any video, even when the video's ATS is earlier", () => {
    const pat = psiPacket(0, patSection(0x100), 40);
    const pmt = psiPacket(0x100, pmtFor([{ pid: VIDEO, streamType: 0x1b }, { pid: 0x1200, streamType: 0x90 }]), 41);
    const source = { ...sources[0]!, kept: [{ spn: 0, bytes: pat }, { spn: 0, bytes: pmt }, ...sources[0]!.kept] };
    const out = packetsOf(bytesOf(remuxInterval(inputFor(intervals[0]!, source, videoOf(packets, intervals[0]!)))));
    expect(out.slice(0, 2).map(pidOf)).toEqual([0, 0x100]);
    expect(out.findIndex((p) => pidOf(p) === VIDEO)).toBeGreaterThan(1);
    expect(out.map(atsOf).every((a, i, all) => i === 0 || a >= all[i - 1]!)).toBe(true);
  });

  it('orders kept packets by assigned SPN and raises an ATS that would go back', () => {
    const at = (pid: number, ats: number): Uint8Array => {
      const p = new Uint8Array(PACKET).fill(0xff);
      p.set([0x40 | ((ats >>> 24) & 0x3f), (ats >>> 16) & 0xff, (ats >>> 8) & 0xff, ats & 0xff, 0x47, pid >> 8, pid & 0xff, 0x10]);
      return p;
    };
    // A core PES assigned to SPN 10 whose tail arrived at ATS 30, then a PG packet at SPN 12 (ATS 12), given out of order.
    const kept = [
      { spn: 12, bytes: at(0x1200, 12) },
      { spn: 10, bytes: at(0x1100, 10) },
      { spn: 10, bytes: at(0x1100, 30) },
    ];
    const plan = { ...intervals[1]!, budgetBytes: 6144 };
    const out = packetsOf(bytesOf(remuxInterval({ plan, kept, video: [], videoPid: VIDEO, videoTimeline: [], pcr: null })));
    expect(out.slice(0, 3).map((p) => [pidOf(p), atsOf(p)])).toEqual([[0x1100, 10], [0x1100, 30], [0x1200, 30]]);
    expect(out[2]![0]! & 0xc0).toBe(0x40); // copy_permission_indicator kept
    expect(out.slice(0, 3).map(strip)).toEqual([kept[1]!.bytes, kept[2]!.bytes, kept[0]!.bytes].map(strip));
  });

  it('pads with null packets that carry a valid TP_extra_header and run up to the next interval', () => {
    const out = packetsOf(outputs0());
    const nulls = out.filter((p) => pidOf(p) === 0x1fff);
    expect(nulls.length).toBeGreaterThan(0);
    for (const p of nulls) {
      expect(p[0]! & 0xc0).toBe(0);
      expect(p[4]).toBe(0x47);
      expect(p[7]).toBe(0x10);
      expect(p.subarray(8).every((b) => b === 0xff)).toBe(true);
    }
    expect(atsOf(nulls.at(-1)!)).toBeLessThanOrEqual(sources[0]!.endAts!);
  });

  function outputs0(): Uint8Array {
    return bytesOf(remuxInterval(inputFor(intervals[0]!, sources[0]!, videoOf(packets, intervals[0]!))));
  }
});

describe('remuxInterval with PCR on the video PID', () => {
  // The fixture's ATS counts packets; spread it to a 27 MHz arrival clock over the clip's 10 s, and give the video PID a
  // PCR every 40 ms, as a disc whose PCR rides on its video.
  const m2ts = readFileSync(join(fixture('disc-levels'), 'STREAM/00001.m2ts'));
  const source = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));
  const clpi = parseClpi(readFileSync(join(fixture('disc-levels'), 'CLIPINF/00001.clpi')));
  const { intervals } = planClip(clpi, LEVELS['h264-1080'], 192_000);
  const ticks = Math.floor(270_000_000 / source.length);
  const PCR0 = 600 * 27_000_000; // the STC at the clip's first packet
  let nextPcr = 0;
  const packets = source.map((p, spn) => {
    const q = p.slice();
    const ats = spn * ticks;
    q.set([(ats >>> 24) & 0x3f, (ats >>> 16) & 0xff, (ats >>> 8) & 0xff, ats & 0xff]);
    if (pidOf(q) === VIDEO && (q[7]! & 0x30) === 0x30 && q[8]! >= 7 && ats >= nextPcr) {
      q[9] = 0x10;
      const pcr = PCR0 + ats;
      const base = Math.floor(pcr / 300);
      q.set([Math.floor(base / 2 ** 25) & 0xff, Math.floor(base / 2 ** 17) & 0xff, Math.floor(base / 2 ** 9) & 0xff, Math.floor(base / 2) & 0xff, ((base % 2) << 7) | 0x7e | ((pcr % 300) >> 8), (pcr % 300) & 0xff], 10);
      nextPcr = ats + 1_080_000;
    }
    return q;
  });
  const sources = collectAll(packets, intervals, cases[0]!.streams(), VIDEO);

  const readPcr = (p: Uint8Array): number => {
    const base = p[10]! * 2 ** 25 + p[11]! * 2 ** 17 + p[12]! * 2 ** 9 + p[13]! * 2 + (p[14]! >> 7);
    return base * 300 + (((p[14]! & 1) << 8) | p[15]!);
  };

  it('collects a PCR anchor from the video PID for every interval', () => {
    for (const s of sources) {
      expect(s.pcr).not.toBeNull();
      expect(s.pcr!.pcr27).toBe(PCR0 + s.pcr!.ats);
    }
  });

  it('carries PCR on the video PID from the ATS clock, never more than 100 ms apart, through the padding', () => {
    intervals.forEach((plan, k) => {
      const out = packetsOf(bytesOf(remuxInterval(inputFor(plan, sources[k]!, videoOf(packets, plan), { pcr: sources[k]!.pcr }))));
      const pcrs = out.filter((p) => pidOf(p) === VIDEO && (p[7]! & 0x30) === 0x20);
      expect(pcrs.length).toBeGreaterThan(0);
      for (const p of pcrs) expect(readPcr(p)).toBe(PCR0 + atsOf(p));
      const at = pcrs.map(atsOf);
      expect(at[0]).toBe(atsOf(out[0]!));
      for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeLessThanOrEqual(PCR_PERIOD_27);
      const end = sources[k]!.endAts ?? atsOf(out.at(-1)!);
      expect(end - at.at(-1)!).toBeLessThanOrEqual(PCR_PERIOD_27);
      // Adaptation-only packets don't advance the counter: the demuxer still gets every video PES.
      expect(demux(out).pes.filter((p) => p.pid === VIDEO).map((p) => p.payload)).toEqual(pesIn(packets, VIDEO, plan).map((p) => p.payload));
    });
  });

  it('names the video PID as PCR_PID in the PMT, with a valid CRC', () => {
    const pmt = psiPacket(0x100, pmtFor([{ pid: VIDEO, streamType: 0x1b }, { pid: 0x1200, streamType: 0x90 }], { pcrPid: 0x1001 }), 0);
    const source = { ...sources[3]!, kept: [{ spn: intervals[3]!.srcSpnStart, bytes: pmt }, ...sources[3]!.kept] };
    const out = packetsOf(bytesOf(remuxInterval(inputFor(intervals[3]!, source, videoOf(packets, intervals[3]!), { pcr: source.pcr }))));
    const section = out.find((p) => pidOf(p) === 0x100)!.subarray(9);
    const length = 3 + (((section[1]! & 0x0f) << 8) | section[2]!);
    expect(((section[8]! & 0x1f) << 8) | section[9]!).toBe(VIDEO);
    expect(mpegCrc32(section.subarray(0, length))).toBe(0);
  });
});

describe('IntervalCollector', () => {
  const m2ts = readFileSync(join(fixture('disc-levels'), 'STREAM/00001.m2ts'));
  const packets = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));
  const clpi = parseClpi(readFileSync(join(fixture('disc-levels'), 'CLIPINF/00001.clpi')));
  const { intervals } = planClip(clpi, LEVELS['h264-1080'], 192_000);

  it('hands each interval exactly the kept packets assigned to it, waiting for the PES that start in it', () => {
    const all: KeptPacket[] = [];
    const streams = cases[0]!.streams();
    for (const [i, p] of packets.entries()) all.push(...streams.filter(p, i));
    all.push(...streams.flush());
    const sources = collectAll(packets, intervals, cases[0]!.streams());
    intervals.forEach((plan, k) => {
      expect(sources[k]!.kept).toEqual(all.filter((x) => x.spn >= plan.srcSpnStart && x.spn < plan.srcSpnEnd));
    });
    expect(sources.flatMap((s) => s.kept)).toHaveLength(all.length);
  });

  it('is not ready while a PES started in the interval is still open past its end', () => {
    const plan = intervals[1]!;
    const collector = new IntervalCollector(cases[0]!.streams(), VIDEO, 0x1001);
    let spn = 0;
    for (; spn <= plan.srcSpnEnd; spn++) collector.push(packets[spn]!, spn);
    // Fed through the next interval's first packet: ready only if no unit that began in interval 1 is open.
    const open = rawPes(packets, 0x1100).find((r) => r.spn >= plan.srcSpnStart && r.spn < plan.srcSpnEnd && lastPacketOf(r.spn) > plan.srcSpnEnd);
    expect(collector.ready(plan)).toBe(open === undefined);
    for (; !collector.ready(plan); spn++) collector.push(packets[spn]!, spn);
    expect(() => collector.take(plan)).not.toThrow();
    expect(() => new IntervalCollector(cases[0]!.streams(), VIDEO, 0x1001).take(plan)).toThrow();
  });

  /** The SPN of the last packet of the PES on 0x1100 that starts at `start`. */
  function lastPacketOf(start: number): number {
    let last = start;
    for (let i = start + 1; i < packets.length; i++) {
      if (pidOf(packets[i]!) !== 0x1100) continue;
      if (packets[i]![5]! & 0x40) break;
      last = i;
    }
    return last;
  }
});

/** A PSI section on one source packet (pointer_field 0, stuffed with 0xFF), at `ats`. */
function psiPacket(pid: number, section: Uint8Array, ats: number): Uint8Array {
  const p = new Uint8Array(PACKET).fill(0xff);
  p.set([(ats >>> 24) & 0x3f, (ats >>> 16) & 0xff, (ats >>> 8) & 0xff, ats & 0xff, 0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0], 0);
  p.set(section, 9);
  return p;
}

function patSection(pmtPid: number): Uint8Array {
  const body = [0x00, 0xb0, 0, 0x00, 0x00, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (pmtPid >> 8), pmtPid & 0xff];
  body[2] = body.length - 3 + 4;
  const s = new Uint8Array(body.length + 4);
  s.set(body);
  const crc = mpegCrc32(s.subarray(0, body.length));
  s.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], body.length);
  return s;
}
