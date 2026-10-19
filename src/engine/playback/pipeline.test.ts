import { describe, expect, it } from 'vitest';
import { CLIP_START_PTS, VIDEO_PID, buildSyntheticDisc, lpcmStream, syntheticClip, syntheticSource } from '../../../tests/helpers/synthetic-disc';
import { endSegment, odsSegment, simpleMenuSegments } from '../../../tests/helpers/ig-builders';
import { subtitleSegments } from '../../../tests/helpers/pg-builders';
import { buildClpi, buildIndex, buildMpls } from '../../../tests/helpers/bdmv-builders';
import { parseClpi } from '../bdmv/clpi-parser';
import { parseMpls } from '../bdmv/mpls-parser';
import { CodingType } from '../bdmv/stream-types';
import { DiscError, readWhole } from '../disc/byte-source';
import { loadClips } from '../disc/open-disc';
import { Timeline } from '../nav/timeline';
import { PlaybackPipeline, type PipelineAudioUnit, type PipelineConfig, type PipelineUnit } from './pipeline';

async function setup(corruptPacket?: number): Promise<PipelineConfig> {
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', 4, { audio: CodingType.LPCM }), syntheticClip('00002', 4, { audio: CodingType.LPCM })],
    playlists: [{ id: '00000', clipIds: ['00001', '00002'] }],
  });
  const clip = files.get('BDMV/STREAM/00001.m2ts');
  if (corruptPacket !== undefined && clip) clip[corruptPacket * 192 + 4] = 0x00; // break one packet's sync byte
  const source = syntheticSource(files);
  const mpls = parseMpls(await readWhole(source, 'BDMV/PLAYLIST/00000.MPLS'));
  return { source, timeline: new Timeline(mpls.playItems), clips: await loadClips(source, ['00001', '00002']), videoPid: VIDEO_PID, playItems: mpls.playItems, audioStream: 1 };
}

interface Collected {
  video: PipelineUnit[];
  audio: PipelineAudioUnit[];
  ended: number;
  errors: unknown[];
}

function run(
  config: PipelineConfig,
  fromUs: number,
  isFull: (got: Collected) => boolean = () => false,
): { pipeline: PlaybackPipeline; got: Collected; done: Promise<void> } {
  const got: Collected = { video: [], audio: [], ended: 0, errors: [] };
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const pipeline = new PlaybackPipeline(config, {
    video: (u) => got.video.push(u),
    audio: (u) => got.audio.push(u),
    isFull: () => isFull(got),
    ended: () => {
      got.ended++;
      finish();
    },
    failed: (err) => {
      got.errors.push(err);
      finish();
    },
  });
  pipeline.start(fromUs);
  return { pipeline, got, done };
}

/** Lets queued macrotasks and microtasks run, without relying on elapsed time. */
async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PlaybackPipeline PG', () => {
  const subs = (x: number) => subtitleSegments({ x }).map((payload) => ({ pts: CLIP_START_PTS + 90_000, payload }));
  async function pgSetup(): Promise<PipelineConfig> {
    const files = buildSyntheticDisc({
      clips: [
        syntheticClip('00001', 2, { pgStreams: [{ pid: 0x1200, lang: 'eng', units: subs(10) }, { pid: 0x1201, lang: 'jpn', units: subs(20) }] }),
        syntheticClip('00002', 2, { pgStreams: [{ pid: 0x1201, lang: 'eng', units: subs(30) }, { pid: 0x1200, lang: 'jpn', units: subs(40) }] }),
      ],
      playlists: [{ id: '00000', clipIds: ['00001', '00002'] }],
    });
    const source = syntheticSource(files);
    const mpls = parseMpls(await readWhole(source, 'BDMV/PLAYLIST/00000.MPLS'));
    return { source, timeline: new Timeline(mpls.playItems), clips: await loadClips(source, ['00001', '00002']), videoPid: VIDEO_PID, playItems: mpls.playItems, audioStream: null };
  }
  /** `pidFor(item)` is what the PG stream control answers when the pipeline opens that play item. */
  async function collect(config: PipelineConfig, pidFor: (item: number) => number | null, fromUs = 0) {
    const got: PipelineUnit[] = [];
    const items: Array<[number, number]> = [];
    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => (finish = r));
    const p: PlaybackPipeline = new PlaybackPipeline(config, {
      video: () => undefined, audio: () => undefined, pg: (u) => got.push(u), isFull: () => false, ended: () => finish(), failed: () => finish(),
      itemStarted: (index, startUs) => {
        items.push([index, startUs]);
        p.setPgStream(pidFor(index));
      },
    });
    p.start(fromUs);
    await done;
    return { got, items };
  }

  it('delivers units of the selected PID only, asking for it as each play item opens', async () => {
    const { got, items } = await collect(await pgSetup(), (i) => (i === 0 ? 0x1200 : 0x1201));
    expect(items).toEqual([[0, 0], [1, 2_000_000]]);
    const n = subtitleSegments({}).length;
    expect(got).toHaveLength(2 * n);
    expect(got[0]!.ptsUs).toBe(1_000_000);
    expect(got[n]!.ptsUs).toBe(3_000_000);
    // the PCS carries the object position: x 10 in item 1, x 30 in item 2
    const x = (u: PipelineUnit) => (u.data[3 + 11 + 4]! << 8) | u.data[3 + 11 + 5]!;
    expect([x(got[0]!), x(got[n]!)]).toEqual([10, 30]);
  });

  it('reads no PG for a null PID or without a sink', async () => {
    const config = await pgSetup();
    expect((await collect(config, () => null)).got).toEqual([]);
    const { got, done } = run(config, 0);
    await done;
    expect(got.ended).toBe(1);
  });

  it('reports the play item a seek starts in with the seek target', async () => {
    const { items } = await collect(await pgSetup(), () => 0x1200, 2_500_000);
    expect(items).toEqual([[1, 2_500_000]]);
  });
});

describe('PlaybackPipeline IG', () => {
  const menu = (state: 'epochStart' | 'normal' = 'epochStart'): Array<{ pts: number; payload: Uint8Array }> =>
    simpleMenuSegments({ compositionState: state }).map((payload) => ({ pts: CLIP_START_PTS + 90_000, payload }));
  async function igSetup(): Promise<PipelineConfig> {
    const files = buildSyntheticDisc({
      clips: [syntheticClip('00001', 2, { igStreams: [{ pid: 0x1400, units: menu() }, { pid: 0x1401, units: menu('normal') }] }), syntheticClip('00002', 2, { igStreams: [{ pid: 0x1401, units: menu() }, { pid: 0x1400, units: menu('normal') }] })],
      playlists: [{ id: '00000', clipIds: ['00001', '00002'] }],
    });
    const source = syntheticSource(files);
    const mpls = parseMpls(await readWhole(source, 'BDMV/PLAYLIST/00000.MPLS'));
    return { source, timeline: new Timeline(mpls.playItems), clips: await loadClips(source, ['00001', '00002']), videoPid: VIDEO_PID, playItems: mpls.playItems, audioStream: null };
  }
  async function collect(config: PipelineConfig, setStream?: number | null): Promise<PipelineUnit[]> {
    const got: PipelineUnit[] = [];
    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => (finish = r));
    const p = new PlaybackPipeline(config, { video: () => undefined, audio: () => undefined, ig: (u) => got.push(u), isFull: () => false, ended: () => finish(), failed: () => finish() });
    if (setStream !== undefined) p.setIgStream(setStream);
    p.start(0);
    await done;
    return got;
  }

  it('delivers units of the selected IG stream only, resolving its PID per play item', async () => {
    const units = await collect(await igSetup(), 1);
    // item 1: stream 1 is PID 0x1400 (epoch start); item 2: stream 1 is PID 0x1401 (epoch start)
    expect(units).toHaveLength(2 * simpleMenuSegments().length);
    expect(units.every((u) => u.inRange)).toBe(true);
    const stream2 = await collect(await igSetup(), 2);
    expect(stream2).toHaveLength(2 * simpleMenuSegments().length); // the 'normal' sets
    expect(units[0]!.data).not.toEqual(stream2[0]!.data); // epoch-start ICS vs normal ICS
  });

  it('reads no IG without a stream number or a sink, and for a number the play item does not have', async () => {
    const config = await igSetup();
    expect(await collect(config)).toEqual([]);
    expect(await collect(config, null)).toEqual([]);
    expect(await collect(config, 3)).toEqual([]);
    const { got, done } = run({ ...config, igStream: 1 }, 0); // no ig sink
    await done;
    expect(got.ended).toBe(1);
  });

  it('reads a play item started from its beginning from packet 0, so graphics muxed before the first keyframe arrive (_fill_clip)', async () => {
    // a menu whose segments fill several aligned units ahead of the first IDR (the EP map's first entry)
    const big = odsSegment(500, 0, 400, 200, Array.from({ length: 200 }, (_, y) => Array.from({ length: 400 }, (_, x) => ((x * 7 + y * 13) % 250) + 1)));
    const segments = [...simpleMenuSegments().slice(0, -1), ...big, endSegment()];
    const files = buildSyntheticDisc({
      clips: [syntheticClip('00001', 2, { igUnits: segments.map((payload) => ({ pts: CLIP_START_PTS, payload })) })],
      playlists: [{ id: '00000', clipIds: ['00001'] }],
    });
    const source = syntheticSource(files);
    const mpls = parseMpls(await readWhole(source, 'BDMV/PLAYLIST/00000.MPLS'));
    const clips = await loadClips(source, ['00001']);
    expect(clips.get('00001')!.epMaps[0]!.entries[0]!.spn).toBeGreaterThan(64); // the IDR is past the first two aligned units
    const config: PipelineConfig = { source, timeline: new Timeline(mpls.playItems), clips, videoPid: VIDEO_PID, playItems: mpls.playItems, audioStream: null };
    expect(await collect(config, 1)).toHaveLength(segments.length);
  });

  it('takes the stream number from the config', async () => {
    expect((await collect({ ...(await igSetup()), igStream: 1 })).length).toBeGreaterThan(0);
  });
});

describe('PlaybackPipeline', () => {
  it('drops the video PID when nothing decodes it, still reading the audio from the EP map position', async () => {
    const config = { ...(await setup()), readVideo: false };
    const { got, done } = run(config, 3_000_000);
    await done;
    expect(got.video).toEqual([]);
    expect(got.audio.length).toBeGreaterThan(0);
    expect(got.audio[0]!.ptsUs).toBeLessThanOrEqual(3_000_000);
    expect(got.audio[0]!.ptsUs).toBeGreaterThan(2_000_000);
    expect(got.ended).toBe(1);
  });

  it('reads both play items in order on one continuous timeline', async () => {
    const { got, done } = run(await setup(), 0);
    await done;
    expect(got.ended).toBe(1);
    expect(got.video).toHaveLength(192);
    const times = got.video.map((u) => u.ptsUs);
    expect(times[0]).toBe(0);
    expect(times[96]).toBe(4_000_000);
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    expect(got.video.every((u) => u.inRange)).toBe(true);
    expect(got.audio.length).toBeGreaterThan(1500);
  });

  it('resolves the audio PID per play item from the stream number', async () => {
    const files = buildSyntheticDisc({
      clips: [
        syntheticClip('00001', 2, { audioStreams: [lpcmStream(0x1100, 2)] }),
        syntheticClip('00002', 2, { audioStreams: [lpcmStream(0x1101, 2)] }),
        syntheticClip('00003', 2, {}),
      ],
      playlists: [{ id: '00000', clipIds: ['00001', '00002', '00003'] }],
    });
    const source = syntheticSource(files);
    const mpls = parseMpls(await readWhole(source, 'BDMV/PLAYLIST/00000.MPLS'));
    const config: PipelineConfig = {
      source,
      timeline: new Timeline(mpls.playItems),
      clips: await loadClips(source, ['00001', '00002', '00003']),
      videoPid: VIDEO_PID,
      playItems: mpls.playItems,
      audioStream: 1,
    };
    const { got, done } = run(config, 0);
    await done;
    const inItem = (from: number, to: number) => got.audio.filter((u) => u.ptsUs >= from && u.ptsUs < to);
    expect(inItem(0, 2_000_000).length).toBeGreaterThan(300);
    expect(inItem(2_000_000, 4_000_000).length).toBeGreaterThan(300);
    expect(inItem(4_000_000, 6_000_000)).toEqual([]); // the third item has no audio stream
    expect(new Set(got.audio.map((u) => u.codingType))).toEqual(new Set([CodingType.LPCM]));
  });

  it('reads no audio when the stream number is null, and follows setAudioStream on the next start', async () => {
    const config = { ...(await setup()), audioStream: null };
    const silent = run(config, 0);
    await silent.done;
    expect(silent.got.audio).toEqual([]);

    let finish: () => void = () => undefined;
    const done = new Promise<void>((r) => (finish = r));
    const got: PipelineAudioUnit[] = [];
    const p = new PlaybackPipeline(config, { video: () => undefined, audio: (u) => got.push(u), isFull: () => false, ended: () => finish(), failed: () => finish() });
    p.setAudioStream(1);
    p.start(0);
    await done;
    expect(got.length).toBeGreaterThan(0);
  });

  it('starts from the keyframe before a seek target inside the second item', async () => {
    const { got, done } = run(await setup(), 5_500_000);
    await done;
    expect(got.video[0].ptsUs).toBe(5_000_000);
    expect(got.video.every((u) => u.ptsUs >= 5_000_000)).toBe(true);
  });

  it('waits while the sinks are full and stops cleanly', async () => {
    let blocking = true;
    // Each clip fits in one 2 MB read, so blocking after the first batch pauses between play items.
    let reachedFull: () => void = () => undefined;
    const full = new Promise<void>((resolve) => (reachedFull = resolve));
    const { pipeline, got } = run(await setup(), 0, (g) => {
      const isFull = blocking && g.video.length > 0;
      if (isFull) reachedFull();
      return isFull;
    });
    await full;
    const paused = got.video.length;
    expect(paused).toBeGreaterThan(0);
    expect(paused).toBeLessThan(192);
    expect(got.ended).toBe(0);
    pipeline.stop();
    blocking = false;
    await turns(10);
    expect(got.video.length).toBe(paused);
    expect(got.ended).toBe(0);
  });

  it('stops delivering units when stop() is called from inside a sink', async () => {
    const config = await setup();
    const got: Collected = { video: [], audio: [], ended: 0, errors: [] };
    let audioAtStop = -1;
    let calls = 0;
    const pipeline: PlaybackPipeline = new PlaybackPipeline(config, {
      video: (u) => {
        calls++;
        got.video.push(u);
        if (got.video.length === 1) {
          audioAtStop = got.audio.length;
          pipeline.stop();
        }
      },
      audio: (u) => {
        calls++;
        got.audio.push(u);
      },
      isFull: () => false,
      ended: () => got.ended++,
      failed: (err) => got.errors.push(err),
    });
    pipeline.start(0);
    await turns(20);
    expect(got.video).toHaveLength(1);
    expect(got.audio).toHaveLength(audioAtStop);
    expect(calls).toBe(1 + audioAtStop);
    expect(got.ended).toBe(0);
    expect(got.errors).toEqual([]);
  });

  it('abandons the old run when start() is called again mid-batch', async () => {
    const config = await setup();
    const got: Collected = { video: [], audio: [], ended: 0, errors: [] };
    let restarted = false;
    const afterRestart: PipelineUnit[] = [];
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const pipeline: PlaybackPipeline = new PlaybackPipeline(config, {
      video: (u) => {
        got.video.push(u);
        if (restarted) afterRestart.push(u);
        else {
          restarted = true;
          pipeline.start(5_000_000);
        }
      },
      audio: (u) => {
        got.audio.push(u);
      },
      isFull: () => false,
      ended: () => {
        got.ended++;
        finish();
      },
      failed: (err) => {
        got.errors.push(err);
        finish();
      },
    });
    pipeline.start(0);
    await done;
    await turns(20);
    expect(got.errors).toEqual([]);
    expect(got.ended).toBe(1);
    expect(afterRestart.length).toBeGreaterThan(0);
    expect(afterRestart.every((u) => u.ptsUs >= 5_000_000)).toBe(true);
    expect(afterRestart[0].ptsUs).toBe(5_000_000);
  });

  it('reports a missing clip through failed()', async () => {
    const config = await setup();
    const first = config.clips.get('00001');
    if (!first) throw new Error('fixture is missing clip 00001');
    const { got, done } = run({ ...config, clips: new Map([['00001', first]]) }, 5_000_000);
    await done;
    expect(got.errors[0]).toBeInstanceOf(DiscError);
  });

  it('reads each play item from its own STC sequence when PTS restarts inside one clip', async () => {
    // Clip 00003 = clip A then clip B back to back; B's PTS restart (a second STC sequence at SPN = A's size).
    // A and B frames differ in size by one byte, so we can tell which half was read.
    const parts = buildSyntheticDisc({
      clips: [syntheticClip('00001', 4, { frameBytes: 300 }), syntheticClip('00002', 4, { frameBytes: 301 })],
      playlists: [],
    });
    const part = (path: string): Uint8Array<ArrayBuffer> => {
      const bytes = parts.get(path);
      if (!bytes) throw new Error(`fixture is missing ${path}`);
      return bytes;
    };
    const a = part('BDMV/STREAM/00001.m2ts');
    const b = part('BDMV/STREAM/00002.m2ts');
    const aPackets = a.length / 192;
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a);
    merged.set(b, a.length);
    const ca = parseClpi(part('BDMV/CLIPINF/00001.clpi'));
    const cb = parseClpi(part('BDMV/CLIPINF/00002.clpi'));
    const { presentationStart, presentationEnd } = ca.atcSequences[0].stc[0];
    const entries = [...ca.epMaps[0].entries, ...cb.epMaps[0].entries.map((e) => ({ pts: e.pts, spn: e.spn + aPackets }))];
    const video = [{ pid: VIDEO_PID, codingType: CodingType.AVC }];
    const files = new Map<string, Uint8Array<ArrayBuffer>>([
      ['BDMV/index.bdmv', buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [] })],
      ['BDMV/STREAM/00003.m2ts', merged],
      [
        'BDMV/CLIPINF/00003.clpi',
        buildClpi({
          numSourcePackets: merged.length / 192,
          streams: video,
          presentationStart,
          presentationEnd,
          epMaps: [{ pid: VIDEO_PID, entries }],
          stcSequences: [
            { spnStcStart: 0, presentationStart, presentationEnd },
            { spnStcStart: aPackets, presentationStart, presentationEnd },
          ],
        }),
      ],
      [
        'BDMV/PLAYLIST/00000.mpls',
        buildMpls({
          playItems: [
            { clipId: '00003', inTime: presentationStart, outTime: presentationEnd, stcId: 0, video },
            { clipId: '00003', inTime: presentationStart, outTime: presentationEnd, stcId: 1, video },
          ],
        }),
      ],
    ]);
    const source = syntheticSource(files);
    const mpls = parseMpls(await readWhole(source, 'BDMV/PLAYLIST/00000.MPLS'));
    const config: PipelineConfig = { source, timeline: new Timeline(mpls.playItems), clips: await loadClips(source, ['00003']), videoPid: VIDEO_PID, playItems: mpls.playItems, audioStream: null };
    const frameLength = (u: PipelineUnit): number => u.data.length;

    const all = run(config, 0);
    await all.done;
    const lengths = (from: number, to: number): Set<number> => new Set(all.got.video.filter((u) => u.ptsUs >= from && u.ptsUs < to).map(frameLength));
    const first = lengths(0, 4_000_000);
    const second = lengths(4_000_000, 8_000_000);
    expect(all.got.video).toHaveLength(192); // no duplicated or missing frames
    expect([...first].every((l) => !second.has(l))).toBe(true); // item 1 read only half A, item 2 only half B

    const seek = run(config, 5_000_000);
    await seek.done;
    // Reading starts at the aligned unit before item 2's 5 s entry point: inside item 2, from half B.
    expect(seek.got.video[0].ptsUs).toBeGreaterThanOrEqual(4_000_000);
    expect(seek.got.video[0].ptsUs).toBeLessThanOrEqual(5_000_000);
    expect(seek.got.video.every((u) => second.has(frameLength(u)))).toBe(true);
  });

  it('keeps packet-error counts from a read that was stopped part-way (e.g. by a seek)', async () => {
    let blocking = true;
    const { pipeline, got } = run(await setup(3), 0, (g) => blocking && g.video.length > 0);
    await new Promise((r) => setTimeout(r, 30)); // first clip read, paused before the second
    pipeline.stop();
    blocking = false;
    expect(got.video.length).toBeGreaterThan(0);
    expect(pipeline.stats.corruptPackets).toBe(1);
  });

  it('stop() aborts the reads still in flight', async () => {
    const config = await setup();
    const signals: AbortSignal[] = [];
    const inner = config.source;
    const source = { exists: inner.exists.bind(inner), size: inner.size.bind(inner), list: inner.list.bind(inner),
      read: (path: string, offset: number, length: number, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        return inner.read(path, offset, length, signal);
      },
    };
    const { pipeline, got } = run({ ...config, source }, 0, (g) => g.video.length > 0); // parks after the first chunk, its prefetch in flight
    await turns(5);
    expect(signals.length).toBeGreaterThan(0);
    pipeline.stop();
    expect(signals.every((s) => s.aborted)).toBe(true);
    await turns(5);
    expect(got.errors).toEqual([]);
  });
});
