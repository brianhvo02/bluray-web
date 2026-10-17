import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildSoundBdmv, type IndexSpec } from '../../tests/helpers/bdmv-builders';
import { asm, buildMovieObjects, imm } from '../../tests/helpers/hdmv-builders';
import { simpleMenuSegments } from '../../tests/helpers/ig-builders';
import { clearSegments, subtitleSegments } from '../../tests/helpers/pg-builders';
import { CLIP_START_PTS, buildSyntheticDisc, discEntries, dummyAudioStream, lpcmStream, syntheticClip, type SyntheticAudioStream, type SyntheticDiscSpec, type SyntheticPgStream, type SyntheticPlaylistSpec, type SyntheticSubPathIg } from '../../tests/helpers/synthetic-disc';
import { readFontFile } from './ass/font-tables';
import { createFixedMeasurer } from './ass/measure';
import { Control, createRing, renderQuantum, ringViews, type RingViews } from './audio/ring';
import { CodingType } from './bdmv/stream-types';
import { createAudioDecoderFactory, type AudioDecoderFactory } from './decode/audio-decoder';
import type { VideoCodecApi, VideoDecoderLike } from './decode/video-decoder';
import { OverlayPlane } from './graphics/overlay-plane';
import { RegisterFile } from './hdmv/registers';
import { Navigator } from './nav/navigator';
import { Player, type PlayerDeps } from './player';
import type { EngineEvent, PlaybackState, ShaderSetData, Telemetry } from './protocol';
import { ShaderStage } from './shaders/stage';
import { UNAVAILABLE, type CompiledSet, type ShaderBackend } from './shaders/webgl-backend';

const decoders: FakeDecoder[] = [];

class FakeDecoder implements VideoDecoderLike {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  constructor(private readonly init: VideoDecoderInit) {
    decoders.push(this);
  }
  configure(): void {
    this.state = 'configured';
  }
  decode(chunk: EncodedVideoChunk): void {
    const { timestamp } = chunk as unknown as EncodedVideoChunkInit;
    this.init.output({ timestamp, displayWidth: 320, displayHeight: 180, close: () => undefined } as unknown as VideoFrame);
  }
  async flush(): Promise<void> {}
  reset(): void {
    this.state = 'unconfigured';
  }
  close(): void {
    this.state = 'closed';
  }
}

const fakeApi: VideoCodecApi = {
  create: (init) => new FakeDecoder(init),
  isConfigSupported: async (config) => ({ supported: true, config }),
  makeChunk: (init) => init as unknown as EncodedVideoChunk,
};

/** 5 render quanta = 640 frames at 48 kHz. */
const STEP_MS = 640 / 48;

interface Harness {
  player: Player;
  events: EngineEvent[];
  drawn: number[];
  /** The IG planes handed to drawIg, one entry per call. */
  igDraws: OverlayPlane[];
  /** The PG planes handed to drawPg, one entry per call. */
  pgDraws: OverlayPlane[];
  /** Callbacks the engine registered with requestFrame. */
  frames: Array<() => void>;
  /** Compositor draw calls in order: `video:<timestamp|null>`, `pg`, `ig`. */
  order: string[];
  /** The shader stages handed to setShaderStage, one entry per call. */
  shaderStages: Array<ShaderStage | null>;
  /** The disc's files, to open it again. */
  entries: ReturnType<typeof discEntries>;
  /** Whether the engine has the ring in its playing state. */
  ringPlaying(): boolean;
  /** Advance simulated time; the fake worklet consumes audio unless audio: false; ticks unless render: false. */
  play(ms: number, opts?: { render?: boolean; audio?: boolean }): Promise<void>;
}

const noWasmFactory = createAudioDecoderFactory(() => Promise.reject(new Error('no wasm in unit tests')));

interface FakeAudioLog {
  decoded: number[];
  resets: number;
  failNext: number;
}

/** LPCM decodes for real; AC-3 decodes to silence 240 frames per unit, failing `failNext` units first. */
function fakeAudioFactory(log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 }, gate?: Promise<void>): AudioDecoderFactory {
  return async (codingType) => {
    if (codingType !== CodingType.AC3) return noWasmFactory(codingType);
    await gate;
    return {
      decode: (u) => {
        if (log.failNext > 0) {
          log.failNext--;
          return { chunks: [], failedFrames: 1 };
        }
        log.decoded.push(u.ptsUs);
        return { chunks: [{ ptsUs: u.ptsUs, sampleRate: 48_000, frames: 240, stereo: new Float32Array(480) }], failedFrames: 0 };
      },
      reset: () => {
        log.resets++;
      },
      close: () => undefined,
    };
  };
}

async function harness(audio: number | undefined, opts: { corruptAudioPesIndex?: number; videoCodingType?: number; throwOnDraw?: boolean; audioMuxLag90k?: number; frameBytes?: number; playlists?: SyntheticPlaylistSpec[]; audioStreams?: SyntheticAudioStream[]; secondClipAudioStreams?: SyntheticAudioStream[]; createAudioDecoder?: AudioDecoderFactory; movieObjects?: Uint8Array<ArrayBuffer>; dropFiles?: string[]; extraFiles?: Record<string, Uint8Array<ArrayBuffer>>; igUnits?: Array<{ pts: number; payload: Uint8Array }>; subPathIg?: SyntheticSubPathIg; pgStreams?: SyntheticPgStream[]; createAssDeps?: NonNullable<PlayerDeps['createAssDeps']>; createShaderBackend?: PlayerDeps['createShaderBackend']; index?: SyntheticDiscSpec['index'] } = {},
): Promise<Harness> {
  decoders.length = 0;
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', 4, { audio, corruptAudioPesIndex: opts.corruptAudioPesIndex, frameBytes: opts.frameBytes, audioStreams: opts.audioStreams, igUnits: opts.igUnits, pgStreams: opts.pgStreams }), syntheticClip('00002', 4, { audio, audioMuxLag90k: opts.audioMuxLag90k, frameBytes: opts.frameBytes, audioStreams: opts.secondClipAudioStreams ?? opts.audioStreams })],
    playlists: opts.playlists ?? [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2, videoCodingType: opts.videoCodingType }],
    movieObjects: opts.movieObjects,
    index: opts.index,
    subPathIg: opts.subPathIg,
  });
  for (const f of opts.dropFiles ?? []) files.delete(f);
  for (const [path, bytes] of Object.entries(opts.extraFiles ?? {})) files.set(path, bytes);
  const events: EngineEvent[] = [];
  const drawn: number[] = [];
  const igDraws: OverlayPlane[] = [];
  const pgDraws: OverlayPlane[] = [];
  const frames: Array<() => void> = [];
  const order: string[] = [];
  const shaderStages: Array<ShaderStage | null> = [];
  let stage: ShaderStage | null = null;
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeApi,
    nowMs: () => clock.ms,
    requestFrame: (cb) => frames.push(cb),
    createAudioDecoder: opts.createAudioDecoder ?? noWasmFactory,
    createAssDeps: opts.createAssDeps ?? fakeAssDeps(),
    createShaderBackend: opts.createShaderBackend,
    createCompositor: () => ({
      resize: () => undefined,
      drawVideo: (f) => {
        if (f && opts.throwOnDraw) throw new Error('draw exploded');
        order.push(`video:${f?.timestamp ?? null}`);
        if (f) stage?.process(f, { width: 320, height: 180 });
        if (f) drawn.push(f.timestamp);
      },
      drawIg: (plane) => {
        order.push('ig');
        igDraws.push(plane);
        plane.takeDirty();
      },
      drawPg: (plane) => {
        order.push('pg');
        pgDraws.push(plane);
        plane.takeDirty();
      },
      setShaderStage: (s) => {
        shaderStages.push(s);
        stage = s;
      },
    }),
  });
  const ring = createRing(48_000, 2);
  const views: RingViews = ringViews(ring);
  await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  const entries = discEntries(files);
  await player.handle({ type: 'open', entries });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    player,
    events,
    drawn,
    igDraws,
    pgDraws,
    frames,
    order,
    shaderStages,
    entries,
    ringPlaying: () => Atomics.load(views.control, Control.Playing) === 1,
    async play(ms, opts = {}) {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        clock.ms += STEP_MS;
        if (opts.audio !== false) for (let q = 0; q < 5; q++) renderQuantum(views, left, right);
        if (opts.render !== false) player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

const states = (h: Harness): PlaybackState[] => h.events.flatMap((e) => (e.type === 'state' ? [e.state] : []));
const lastState = (h: Harness): PlaybackState | undefined => states(h).at(-1);
const lastTelemetry = (h: Harness): Telemetry | undefined => h.events.flatMap((e) => (e.type === 'telemetry' ? [e.telemetry] : [])).at(-1);

async function untilPlaying(h: Harness): Promise<void> {
  await vi.waitFor(
    async () => {
      await h.play(20);
      expect(lastState(h)).toBe('playing');
    },
    { timeout: 5000 },
  );
}

describe('Player', () => {
  it('opens a disc and lists playlists', async () => {
    const h = await harness(CodingType.LPCM);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'titles', usesBdj: false, playlists: [expect.objectContaining({ id: '00000', durationUs: 8_000_000, chapterCount: 4, playable: true })] }),
    );
  });

  it('reports a render-loop exception once and keeps scheduling frames', async () => {
    const h = await harness(CodingType.LPCM, { throwOnDraw: true });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await vi.waitFor(
      async () => {
        await h.play(20, { render: false });
        expect(h.events.some((e) => e.type === 'state' && e.state === 'buffering')).toBe(true);
      },
      { timeout: 5000 },
    );
    const scheduled = h.frames.length;
    await vi.waitFor(
      () => {
        h.frames.at(-1)?.();
        expect(h.events.filter((e) => e.type === 'error' && e.code === 'internal')).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    h.frames.at(-1)?.();
    h.frames.at(-1)?.();
    expect(h.frames.length).toBeGreaterThan(scheduled);
    expect(h.events.filter((e) => e.type === 'error' && e.code === 'internal')).toHaveLength(1);
  });

  it('plays AC-3 audio on the audio clock through the decoder factory', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(CodingType.AC3, { createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1000);
    expect(log.decoded.length).toBeGreaterThan(100);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'Dolby Digital (AC-3)', audioDecodeErrors: 0 });
  });

  it('falls back to the wall clock when the audio decoder cannot load', async () => {
    const h = await harness(CodingType.AC3); // noWasmFactory
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'audio', codec: 'Dolby Digital (AC-3)' }));
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(1000);
    expect(h.drawn.length).toBeGreaterThan(15);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('resets the audio decoders on seek', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(CodingType.AC3, { createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const before = log.resets;
    await h.player.handle({ type: 'seek', timeUs: 3_000_000 });
    expect(log.resets).toBeGreaterThan(before);
  });

  it('disables audio after more than 50 failed frames in a row and retries on the next seek', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(CodingType.AC3, { createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    log.failNext = 60;
    // the tiny synthetic clips are fully read ahead by now, so a seek is what makes the pipeline decode again
    await h.player.handle({ type: 'seek', timeUs: 500_000 });
    await h.play(1000);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'audio-disabled' }));
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    expect(lastTelemetry(h)?.audioDecodeErrors).toBeGreaterThan(50);
    await h.player.handle({ type: 'seek', timeUs: 1_000_000 });
    await untilPlaying(h);
    await h.play(1000);
    expect(lastTelemetry(h)?.clockMode).toBe('audio');
  });

  it('reports a folder without BDMV', async () => {
    const events: EngineEvent[] = [];
    const player = new Player({ emit: (e) => events.push(e), videoCodecApi: fakeApi, nowMs: () => 0, requestFrame: () => undefined, createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }), createAudioDecoder: noWasmFactory });
    await player.handle({ type: 'open', entries: [['Stuff/readme.txt', new Blob(['hi'])]] });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'not-bdmv' }));
    expect(events.at(-1)).toEqual({ type: 'state', state: 'error' });
  });

  it('re-enables audio on the next seek once a stalled output is running again', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1200, { audio: false }); // output stalls → wall-clock fallback
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    await h.play(100); // the output is running again (heartbeat advances)
    await h.player.handle({ type: 'seek', timeUs: 2_000_000 });
    await untilPlaying(h);
    await h.play(1000);
    expect(lastTelemetry(h)?.clockMode).toBe('audio');
  });

  it('keeps unsupported audio off after a seek', async () => {
    const h = await harness(CodingType.EAC3_SECONDARY);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'seek', timeUs: 2_000_000 });
    await untilPlaying(h);
    await h.play(1000);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('tells the UI the old playlist is gone when picking another one fails', async () => {
    const h = await harness(CodingType.LPCM, {
      playlists: [
        { id: '00000', clipIds: ['00001'] },
        { id: '00001', clipIds: ['00002'], videoCodingType: CodingType.VC1 },
      ],
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const n = h.events.length;
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    const after = h.events.slice(n);
    expect(after).toContainEqual({ type: 'playlistCleared' });
    expect(after).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'video' }));
    expect(after.findIndex((e) => e.type === 'playlistCleared')).toBeLessThan(after.findIndex((e) => e.type === 'unsupported'));
    expect(lastState(h)).toBe('error');
  });

  it('closes the disc: stops playback, clears the playlist and reports idle', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'close' });
    expect(h.events.at(-1)).toEqual({ type: 'state', state: 'idle' });
    expect(h.events).toContainEqual({ type: 'playlistCleared' });
    const n = h.events.length;
    await h.play(600);
    expect(h.events.slice(n)).toEqual([]);
  });

  it('keeps audio fed when the multiplex puts video 600 ms ahead of audio (regression: real-disc boundary underrun)', async () => {
    // ~200 KB/frame ≈ 38 Mbps, so each ~2 MB read covers ~0.4 s, as on a real disc.
    const h = await harness(CodingType.LPCM, { audioMuxLag90k: 54_000, frameBytes: 200_000 });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const before = lastTelemetry(h)?.audioUnderruns ?? 0;
    await h.play(6000); // crosses into the lagged second clip at 4 s
    const t = lastTelemetry(h);
    expect(t?.clockUs ?? 0).toBeGreaterThan(5_000_000);
    expect((t?.audioUnderruns ?? 0) - before).toBe(0);
  });

  it('plays on the audio clock, in order, across the play-item boundary', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual({
      type: 'chapters',
      playlistId: '00000',
      durationUs: 8_000_000,
      chapters: [0, 2_000_000, 4_000_000, 6_000_000].map((startUs, index) => ({ index, startUs })),
    });
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(5000);
    expect(h.drawn.length).toBeGreaterThan(100);
    expect(h.drawn.every((t, i) => i === 0 || t > h.drawn[i - 1])).toBe(true);
    expect(Math.max(...h.drawn)).toBeGreaterThan(4_500_000);
    const telemetry = lastTelemetry(h);
    expect(telemetry?.clockMode).toBe('audio');
    expect(Math.abs(telemetry?.avOffsetMeanUs ?? Infinity)).toBeLessThanOrEqual(20_000);
    expect(telemetry?.bdj).toBeNull(); // no BD-J title ran on this disc
  });

  it('applies only the last of several rapid seeks and never draws earlier frames', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await Promise.all([
      h.player.handle({ type: 'seek', timeUs: 1_000_000 }),
      h.player.handle({ type: 'seek', timeUs: 6_000_000 }),
      h.player.handle({ type: 'seek', timeUs: 3_000_000 }),
    ]);
    h.drawn.length = 0;
    await untilPlaying(h);
    await h.play(300);
    expect(Math.min(...h.drawn)).toBeGreaterThanOrEqual(2_999_000);
    expect(Math.min(...h.drawn)).toBeLessThan(3_100_000);
  });

  it('plays video on the wall clock when the only audio is unsupported', async () => {
    const h = await harness(CodingType.EAC3_SECONDARY);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'audio', codec: 'Dolby Digital Plus (secondary)' }));
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(1000);
    expect(h.drawn.length).toBeGreaterThan(15);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('keeps reading while rendering is throttled and catches up afterwards', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(2500, { render: false });
    h.player.tick();
    const time = h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : [])).at(-1) ?? 0;
    expect(time).toBeGreaterThan(2_400_000);
    expect(h.drawn.at(-1) ?? 0).toBeGreaterThan(time - 100_000);
    expect(lastState(h)).toBe('playing');
  });

  it('falls back to the wall clock when the audio output stops running', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1200, { audio: false });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'notice', code: 'audio-disabled' }));
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('goes back to the audio clock by itself once a stalled output runs again, without a seek', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1200, { audio: false }); // e.g. a slow output start while another client opens a stream
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    await vi.waitFor(
      async () => {
        await h.play(100);
        expect(lastTelemetry(h)?.clockMode).toBe('audio');
      },
      { timeout: 5000 },
    );
    expect(lastState(h)).toBe('playing');
  });

  it('seeking while paused shows the target frame and stays paused', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'pause' });
    expect(lastState(h)).toBe('paused');
    h.drawn.length = 0;
    await h.player.handle({ type: 'seek', timeUs: 5_000_000 });
    await vi.waitFor(async () => {
      await h.play(20);
      expect(h.drawn.length).toBeGreaterThan(0);
    });
    expect(h.drawn[0]).toBeGreaterThanOrEqual(4_999_000);
    expect(h.drawn[0]).toBeLessThan(5_100_000);
    await h.play(500);
    expect(lastState(h)).toBe('paused');
    expect(h.drawn).toHaveLength(1); // a paused preview: one frame, no playback
    expect(h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : [])).at(-1)).toBe(5_000_000);
  });

  it('jumps to the next chapter', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'nextChapter' });
    expect(h.events).toContainEqual({ type: 'time', timeUs: 2_000_000 });
  });

  it('skips a chapter that starts within the guard instead of landing just ahead', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'seek', timeUs: 1_800_000 });
    await untilPlaying(h);
    const mark = h.events.length;
    await h.player.handle({ type: 'nextChapter' });
    expect(h.events.slice(mark)).toContainEqual({ type: 'time', timeUs: 4_000_000 }); // 2.0 s is under 0.5 s away
  });

  it('leaves the clock running when there is no next chapter', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'seek', timeUs: 6_200_000 });
    await untilPlaying(h);
    await h.play(300);
    const times = (from: number): number[] => h.events.slice(from).flatMap((e) => (e.type === 'time' ? [e.timeUs] : []));
    const before = times(0).at(-1) ?? 0;
    expect(before).toBeGreaterThan(6_300_000);
    const mark = h.events.length;
    await h.player.handle({ type: 'nextChapter' });
    await h.play(600);
    const after = h.events.slice(mark);
    expect(after.filter((e) => e.type === 'state')).toEqual([]);
    const clock = times(mark);
    expect(clock.length).toBeGreaterThan(0);
    // The clock kept advancing from where it was: no seek to a target, no pause.
    expect(clock.every((t, i) => t > (i === 0 ? before : clock[i - 1]))).toBe(true);
    expect((clock.at(-1) ?? 0) - before).toBeGreaterThan(400_000);
  });

  it('reaches the ended state at the end of the playlist', async () => {
    const h = await harness(CodingType.EAC3_SECONDARY);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(8500);
    expect(lastState(h)).toBe('ended');
  });

  it('counts no underruns when the audio runs out at the end of the playlist', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(9000);
    expect(lastState(h)).toBe('ended');
    expect(lastTelemetry(h)?.audioUnderruns).toBe(0);
  });

  it('reports unsupported video instead of hanging in buffering', async () => {
    const h = await harness(CodingType.LPCM, { videoCodingType: CodingType.VC1 });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'video', codec: 'VC-1' }));
    expect(lastState(h)).toBe('error');
  });

  it('serializes commands so a double playPlaylist leaves one live session', async () => {
    const h = await harness(CodingType.LPCM);
    await Promise.all([h.player.handle({ type: 'playPlaylist', playlistId: '00000' }), h.player.handle({ type: 'playPlaylist', playlistId: '00000' })]);
    await untilPlaying(h);
    h.drawn.length = 0;
    await h.play(1000);
    expect(h.drawn.length).toBeGreaterThan(15);
    expect(h.drawn.every((t, i) => i === 0 || t > h.drawn[i - 1])).toBe(true);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    expect(decoders.filter((d) => d.state !== 'closed')).toHaveLength(1);
    expect(decoders.filter((d) => d.state === 'closed').length).toBe(decoders.length - 1);
  });

  it('drops a corrupt LPCM unit without disabling audio', async () => {
    const h = await harness(CodingType.LPCM, { corruptAudioPesIndex: 100 });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(2000);
    expect(h.events.some((e) => e.type === 'notice' && e.code === 'audio-disabled')).toBe(false);
    expect(h.events.some((e) => e.type === 'unsupported')).toBe(false);
    expect(lastTelemetry(h)?.clockMode).toBe('audio');
    expect(lastTelemetry(h)?.corruptPackets).toBeGreaterThanOrEqual(1);
  });

  const twoTracks = (second: number) => [lpcmStream(0x1100, 4, { lang: 'jpn' }), dummyAudioStream(0x1101, second, 4, { lang: 'eng' })];
  const tracksEvents = (h: Harness) => h.events.flatMap((e) => (e.type === 'tracks' ? [e] : []));

  it('lists the audio tracks after the chapters and selects the first playable one', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('tracks')).toBeGreaterThan(types.indexOf('chapters'));
    expect(tracksEvents(h).at(-1)).toEqual({
      type: 'tracks',
      selectedAudio: 1,
      audio: [
        { index: 1, codec: 'LPCM', language: 'jpn', channels: 'stereo', playable: true },
        { index: 2, codec: 'Dolby Digital (AC-3)', language: 'eng', channels: 'stereo', playable: true },
      ],
    });
  });

  it('switches the audio track at the current time and keeps playing', async () => {
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory(log) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1500);
    const at = lastTelemetry(h)?.clockUs ?? 0;
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(tracksEvents(h).at(-1)?.selectedAudio).toBe(2);
    await untilPlaying(h);
    await h.play(800);
    expect(Math.min(...log.decoded)).toBeGreaterThan(at - 1_100_000); // read from the keyframe before the switch point
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'Dolby Digital (AC-3)' });
  });

  it('switching while paused stays paused at the same time', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(1000);
    await h.player.handle({ type: 'pause' });
    const pausedAt = lastTelemetry(h)?.clockUs ?? 0;
    await h.player.handle({ type: 'selectAudio', index: 2 });
    await h.play(300);
    expect(lastState(h)).toBe('paused');
    const lastTime = h.events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : [])).at(-1) ?? -1;
    expect(Math.abs(lastTime - pausedAt)).toBeLessThan(300_000);
  });

  it('ignores unplayable, unknown and already-selected tracks', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.EAC3_SECONDARY), createAudioDecoder: fakeAudioFactory() });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const before = h.events.length;
    for (const index of [2, 9, 1]) await h.player.handle({ type: 'selectAudio', index });
    expect(h.events.slice(before).filter((e) => e.type === 'tracks' || (e.type === 'state' && e.state === 'buffering'))).toEqual([]);
  });

  it('applies two quick switches in order: the last one wins, with no stale decoder output (commands are serialized)', async () => {
    // Player.handle serializes commands, so the gated load of the first switch finishes before the second runs.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const log: FakeAudioLog = { decoded: [], resets: 0, failNext: 0 };
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory(log, gate) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    const toAc3 = h.player.handle({ type: 'selectAudio', index: 2 });
    const back = h.player.handle({ type: 'selectAudio', index: 1 });
    open();
    await Promise.all([toAc3, back]);
    await untilPlaying(h);
    log.decoded.length = 0;
    await h.play(800);
    expect(tracksEvents(h).at(-1)?.selectedAudio).toBe(1);
    expect(log.decoded).toEqual([]);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'LPCM' });
  });

  it('brings sound back by switching to a playable track after a decoder failed to load', async () => {
    const h = await harness(undefined, { audioStreams: [dummyAudioStream(0x1100, CodingType.AC3, 4), lpcmStream(0x1101, 4)] }); // noWasmFactory
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(500);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
    await h.player.handle({ type: 'selectAudio', index: 2 });
    await untilPlaying(h);
    await h.play(800);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'LPCM' });
  });

  it('stops the ring when the decoder of the switched-to track cannot load, so no stale audio plays on', async () => {
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3) }); // noWasmFactory: AC-3 fails to load
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(500);
    expect(h.ringPlaying()).toBe(true);
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
    expect(h.ringPlaying()).toBe(false);
    await untilPlaying(h);
    await h.play(800);
    expect(h.ringPlaying()).toBe(false);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  it('shows buffering with the old audio stopped while the new track decoder is still loading', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const h = await harness(undefined, { audioStreams: twoTracks(CodingType.AC3), createAudioDecoder: fakeAudioFactory(undefined, gate) });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.play(20);
    await vi.waitFor(async () => {
      await h.play(20);
      expect(lastState(h)).toBe('playing');
    });
    expect(h.ringPlaying()).toBe(true);
    const switching = h.player.handle({ type: 'selectAudio', index: 2 });
    await h.play(100);
    expect(lastState(h)).toBe('buffering');
    expect(h.ringPlaying()).toBe(false);
    const frozen = lastTelemetry(h)?.clockUs;
    await h.play(100);
    expect(lastTelemetry(h)?.clockUs).toBe(frozen);
    open();
    await switching;
    await untilPlaying(h);
    await h.play(500);
    expect(lastTelemetry(h)).toMatchObject({ clockMode: 'audio', audioCodec: 'Dolby Digital (AC-3)' });
  });

  it('reports a failing decoder load for a later play item once, with a single load attempt', async () => {
    let loads = 0;
    const h = await harness(undefined, {
      audioStreams: [lpcmStream(0x1100, 4)],
      secondClipAudioStreams: [dummyAudioStream(0x1100, CodingType.AC3, 4)],
      createAudioDecoder: (codingType) => {
        if (codingType === CodingType.AC3) loads++;
        return noWasmFactory(codingType);
      },
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(5500);
    expect(loads).toBe(1);
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });

  /** Item 1 LPCM, item 2 AC-3 whose decoder load stays pending until `fail()` rejects it. */
  async function pendingLaterLoad(): Promise<{ h: Harness; fail: () => void }> {
    let reject: (err: Error) => void = () => undefined;
    let requested = false;
    const h = await harness(undefined, {
      audioStreams: [lpcmStream(0x1100, 4)],
      secondClipAudioStreams: [dummyAudioStream(0x1100, CodingType.AC3, 4)],
      createAudioDecoder: (codingType) => {
        if (codingType !== CodingType.AC3) return noWasmFactory(codingType);
        requested = true;
        return new Promise((_, r) => (reject = r));
      },
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await vi.waitFor(
      async () => {
        await h.play(20);
        expect(requested).toBe(true); // read-ahead reached item 2
      },
      { timeout: 5000 },
    );
    return { h, fail: () => reject(new Error('offline')) };
  }

  it('ignores a later item’s failed decoder load that lands after the user seeked away', async () => {
    const { h, fail } = await pendingLaterLoad();
    await h.player.handle({ type: 'seek', timeUs: 1_000_000 }); // back into the LPCM item
    await untilPlaying(h);
    fail();
    await h.play(500);
    expect(h.events.filter((e) => e.type === 'unsupported')).toEqual([]);
    expect(lastTelemetry(h)?.clockMode).toBe('audio');
  });

  it('reports a failed decoder load once when the user seeks into the item that needs it', async () => {
    const { h, fail } = await pendingLaterLoad();
    const seek = h.player.handle({ type: 'seek', timeUs: 5_000_000 }); // waits on the same pending load
    fail();
    await seek;
    await h.play(300);
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
  });

  it('reports an unplayable codec in a later play item once without trying to load it', async () => {
    let loads = 0;
    const h = await harness(undefined, {
      audioStreams: [lpcmStream(0x1100, 4)],
      secondClipAudioStreams: [dummyAudioStream(0x1100, CodingType.EAC3_SECONDARY, 4)],
      createAudioDecoder: (codingType) => {
        if (codingType === CodingType.EAC3_SECONDARY) loads++;
        return noWasmFactory(codingType);
      },
    });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(5500);
    expect(loads).toBe(0);
    expect(h.events.filter((e) => e.type === 'unsupported')).toHaveLength(1);
    expect(lastTelemetry(h)?.clockMode).toBe('wall');
  });
});

describe('Player with HDMV navigation', () => {
  const idle = { cmds: [] };
  const shortPlaylists = [
    { id: '00000', clipIds: ['00001'], chapterEverySeconds: 1 },
    { id: '00001', clipIds: ['00002'], chapterEverySeconds: 1 },
  ];
  const nav = (objects: Array<{ cmds: Uint8Array[] }>, extra: Parameters<typeof harness>[1] = {}) =>
    harness(CodingType.LPCM, { playlists: shortPlaylists, movieObjects: buildMovieObjects(objects), ...extra });
  const selectedAudio = (h: Harness) => h.events.flatMap((e) => (e.type === 'tracks' ? [e.selectedAudio] : [])).at(-1);
  const chapterIds = (h: Harness) => h.events.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : []));

  it('boots First Play without a playPlaylist command', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
    await untilPlaying(h);
    expect(chapterIds(h)).toEqual(['00000']);
    expect(h.events).toContainEqual({ type: 'indexTitles', titles: [{ number: 1, kind: 'hdmv' }], hasTopMenu: true });
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('indexTitles')).toBeGreaterThan(types.indexOf('titles'));
  });

  it('plays a title at a mark', async () => {
    const h = await nav([idle, idle, { cmds: [asm.playPlPm(imm(1), imm(1))] }]);
    expect(chapterIds(h)).toEqual([]);
    await h.player.handle({ type: 'playTitle', title: 1 });
    await untilPlaying(h);
    await h.play(300);
    expect(chapterIds(h)).toEqual(['00001']);
    expect(Math.abs(h.drawn[0]! - 1_000_000)).toBeLessThanOrEqual(41_667);
  });

  it('starts the next playlist when one ends', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }, idle, idle]);
    await vi.waitFor(
      async () => {
        await h.play(100);
        expect(chapterIds(h)).toEqual(['00000', '00001']);
      },
      { timeout: 10000 },
    );
    expect(states(h)).not.toContain('ended');
  });

  it('follows a VM setStream into the audio selection', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.setStream(imm(0x80020000), imm(0)), asm.playPl(imm(0))] }], {
      audioStreams: [lpcmStream(0x1100, 4, { lang: 'jpn' }), lpcmStream(0x1101, 4, { lang: 'eng' })],
    });
    await untilPlaying(h);
    expect(selectedAudio(h)).toBe(1);
    await h.player.handle({ type: 'playTitle', title: 1 });
    await untilPlaying(h);
    expect(chapterIds(h)).toEqual(['00000', '00000']);
    expect(selectedAudio(h)).toBe(2);
  });

  it('stops the VM when a raw playlist is picked', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(0))] }, idle, idle]);
    await untilPlaying(h);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await vi.waitFor(
      async () => {
        await h.play(100);
        expect(lastState(h)).toBe('ended');
      },
      { timeout: 10000 },
    );
    await h.play(500);
    expect(chapterIds(h)).toEqual(['00000', '00001']);
  });

  it('brings the program back for a title or the top menu after a raw playlist pick', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, { cmds: [asm.playPl(imm(0))] }, { cmds: [asm.playPl(imm(1))] }]);
    await untilPlaying(h);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' }); // raw pick: the navigator stops
    await untilPlaying(h);
    await h.player.handle({ type: 'playTitle', title: 1 });
    await vi.waitFor(async () => {
      await h.play(100);
      expect(chapterIds(h)).toEqual(['00000', '00000', '00001']);
    }, { timeout: 5000 });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await untilPlaying(h);
    await h.player.handle({ type: 'menuCall' });
    await vi.waitFor(async () => {
      await h.play(100);
      expect(chapterIds(h)).toEqual(['00000', '00000', '00001', '00001', '00000']);
    }, { timeout: 5000 });
  });

  describe('menus', () => {
    const menuAt = (seconds: number) => simpleMenuSegments().map((payload) => ({ pts: CLIP_START_PTS + seconds * 90_000, payload }));
    const telemetries = (h: Harness) => h.events.flatMap((e) => (e.type === 'telemetry' ? [e.telemetry] : []));
    const menuEvents = (h: Harness) => h.events.flatMap((e) => (e.type === 'menuActive' ? [e] : []));
    const bootMenu = (extra: Parameters<typeof harness>[1] = {}) => nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { igUnits: menuAt(0.2), ...extra });

    /** Buttons 1 and 2 (8x4 at (100, 100) and (100, 200)) jump to title 1, which plays 00001. */
    const inputMenu = async () => {
      const segments = simpleMenuSegments({ cmds: [asm.jumpTitle(imm(1))] }).map((payload) => ({ pts: CLIP_START_PTS + 0.2 * 90_000, payload }));
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.playPl(imm(1))] }], { igUnits: segments });
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      return h;
    };
    const untilPlaylist = async (h: Harness, id: string) =>
      vi.waitFor(
        async () => {
          await h.play(100);
          expect(chapterIds(h)).toContain(id);
        },
        { timeout: 5000 },
      );

    it('hands the disc sounds over once and plays a button sound on activation', async () => {
      const sounds = buildSoundBdmv([{ channels: 1, samples: new Int16Array(480) }, { channels: 2, samples: new Int16Array(960) }]);
      const segments = simpleMenuSegments({ cmds: [asm.jumpTitle(imm(1))], activatedSound: 1 }).map((payload) => ({ pts: CLIP_START_PTS + 0.2 * 90_000, payload }));
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, { cmds: [asm.playPl(imm(1))] }], { igUnits: segments, extraFiles: { 'BDMV/AUXDATA/sound.bdmv': sounds } });
      const effects = h.events.filter((e) => e.type === 'soundEffects');
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({ type: 'soundEffects', clips: [{ channels: 1 }, { channels: 2 }] });
      await untilPlaying(h);
      await vi.waitFor(async () => {
        await h.play(100);
        expect(lastTelemetry(h)?.menu).not.toBeNull();
      }, { timeout: 5000 });
      expect(lastTelemetry(h)!.soundsPlayed).toBe(0);
      await h.player.handle({ type: 'menuKey', key: 'ok' });
      expect(h.events).toContainEqual({ type: 'soundEffect', id: 1 });
      await h.play(600);
      expect(lastTelemetry(h)!.soundsPlayed).toBe(1);
    });

    it('emits no sounds for a disc without sound.bdmv', async () => {
      const h = await inputMenu();
      expect(h.events.filter((e) => e.type === 'soundEffects')).toEqual([]);
    });

    it('menu keys move the selection and activate a button', async () => {
      const h = await inputMenu();
      await h.player.handle({ type: 'menuKey', key: 'down' });
      await h.play(600); // one telemetry interval
      expect(lastTelemetry(h)!.menu!.selectedButton).toBe(2);
      await h.player.handle({ type: 'menuKey', key: 'ok' });
      await untilPlaylist(h, '00001');
    });

    it('a pointer move reports the button under it and selects it; a click activates it', async () => {
      const h = await inputMenu();
      await h.player.handle({ type: 'pointer', kind: 'move', x: 104, y: 202 });
      expect(h.events.at(-1)).toEqual({ type: 'pointerTarget', button: 2 });
      await h.play(600);
      expect(lastTelemetry(h)!.menu!.selectedButton).toBe(2);
      await h.player.handle({ type: 'pointer', kind: 'move', x: 500, y: 500 });
      expect(h.events.filter((e) => e.type === 'pointerTarget').at(-1)).toEqual({ type: 'pointerTarget', button: null });
      await h.player.handle({ type: 'pointer', kind: 'click', x: 104, y: 102 });
      await untilPlaylist(h, '00001');
    });

    it('ignores menu keys and pointer input without a navigator', async () => {
      const h = await harness(CodingType.LPCM);
      await h.player.handle({ type: 'menuKey', key: 'ok' });
      await h.player.handle({ type: 'pointer', kind: 'click', x: 1, y: 1 });
      expect(h.events.filter((e) => e.type === 'pointerTarget')).toEqual([]);
    });

    it('boots into a menu: telemetry carries the page and the buttons drawn, and menuActive is emitted', async () => {
      const h = await bootMenu();
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const menu = lastTelemetry(h)!.menu!;
      expect(menu.page).toBe(0);
      expect(menu.selectedButton).toBe(1);
      expect(menu.buttonsDrawn).toBeGreaterThan(0);
      expect(menuEvents(h)).toContainEqual({ type: 'menuActive', active: true, popupAvailable: false });
      expect(lastTelemetry(h)!.igErrors).toBe(0);
      expect(h.igDraws.length).toBeGreaterThan(0);
      expect(h.igDraws[0]!.width).toBe(1920);
    });

    it('shows a menu whose display set is muxed at the very start of the clip', async () => {
      const h = await bootMenu({ igUnits: menuAt(0) });
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
    });

    it('does not show the menu before the clock reaches its PTS', async () => {
      const h = await bootMenu({ igUnits: menuAt(3) });
      await untilPlaying(h);
      await h.play(500);
      expect(lastTelemetry(h)?.menu ?? null).toBeNull();
      expect(h.igDraws).toEqual([]);
    });

    it('shows a menu whose IG stream lives in a sub-path clip, decoded from the preloaded clip', async () => {
      const h = await bootMenu({ subPathIg: { clipId: '00009', units: menuAt(0.2) } });
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const menu = lastTelemetry(h)!.menu!;
      expect(menu.selectedButton).toBe(1);
      expect(menu.buttonsDrawn).toBeGreaterThan(0);
      expect(menuEvents(h)).toContainEqual({ type: 'menuActive', active: true, popupAvailable: false });
      expect(lastTelemetry(h)!.igErrors).toBe(0);
      expect(h.igDraws.length).toBeGreaterThan(0);
    });

    it('keeps playing without a menu when the sub-path clip cannot be read', async () => {
      const h = await bootMenu({ subPathIg: { clipId: '00009', units: menuAt(0.2) }, dropFiles: ['BDMV/STREAM/00009.m2ts'] });
      await untilPlaying(h);
      await h.play(700);
      expect(lastState(h)).toBe('playing');
      expect(lastTelemetry(h)).toMatchObject({ menu: null, igErrors: 1 });
      expect(h.igDraws).toEqual([]);
    });

    it('reports no menu for a disc without IG', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
      await untilPlaying(h);
      await h.play(700);
      expect(lastTelemetry(h)).toMatchObject({ menu: null, igErrors: 0 });
      expect(h.igDraws).toEqual([]);
    });

    it('close while a menu is shown clears the plane and stops menu telemetry', async () => {
      const h = await bootMenu();
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const plane = h.igDraws[0]!;
      const emptyHash = new (plane.constructor as new (w: number, h: number) => OverlayPlane)(plane.width, plane.height).hash();
      expect(plane.hash()).not.toBe(emptyHash);
      await h.player.handle({ type: 'close' });
      expect(plane.hash()).toBe(emptyHash);
      expect(menuEvents(h).at(-1)).toMatchObject({ active: false });
      const seen = telemetries(h).length;
      await h.play(1200);
      expect(telemetries(h)).toHaveLength(seen);
    });

    it('a seek keeps the menu that is shown and does not draw units from the old read position', async () => {
      const h = await bootMenu({ igUnits: [...menuAt(0.2), ...simpleMenuSegments({ compositionState: 'normal' }).map((payload) => ({ pts: CLIP_START_PTS + 3 * 90_000, payload }))] });
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const activeEvents = menuEvents(h).length;
      await h.player.handle({ type: 'seek', timeUs: 1_000_000 });
      await h.play(1500);
      expect(menuEvents(h)).toHaveLength(activeEvents);
      expect(menuEvents(h).at(-1)).toMatchObject({ active: true });
      expect(lastTelemetry(h)!.menu).not.toBeNull();
    });

    it('stops drawing the IG plane every frame once it is empty', async () => {
      const h = await bootMenu();
      await untilPlaying(h);
      await vi.waitFor(
        async () => {
          await h.play(100);
          expect(lastTelemetry(h)?.menu).not.toBeNull();
        },
        { timeout: 5000 },
      );
      const plane = h.igDraws[0]!;
      plane.apply({ cmd: 'clear', pts: -1, x: 0, y: 0, w: 0, h: 0 });
      await h.play(100);
      const after = h.igDraws.length; // the clear itself was painted
      await h.play(500);
      expect(h.igDraws).toHaveLength(after);
    });
  });

  describe('disc profile', () => {
    const hdmvIndex: IndexSpec = { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'hdmv', movieObjectId: 0 }] };
    const regsOf = (h: Harness, key: 'navRegs' | 'pgRegs'): { psrRead(i: number): number } => (h.player as unknown as Record<string, { psrRead(i: number): number }>)[key];
    const profile = (r: { psrRead(i: number): number }): number[] => [29, 30, 31, 24, 25].map((i) => r.psrRead(i));
    const movieObjects = buildMovieObjects([{ cmds: [asm.playPl(imm(0))] }]);

    it('leaves an ordinary disc at the default profile', async () => {
      const plain = await harness(undefined);
      const nav = await harness(undefined, { movieObjects, index: hdmvIndex });
      expect(profile(regsOf(plain, 'pgRegs'))).toEqual(profile(new RegisterFile()));
      expect(profile(regsOf(nav, 'navRegs'))).toEqual(profile(new RegisterFile()));
    });

    it('applies the UHD profile to a 0300 index, with and without a navigator', async () => {
      const expected = new RegisterFile();
      expected.psrInitUhd(true);
      const index = { ...hdmvIndex, version: '0300' };
      const plain = await harness(undefined, { index });
      const nav = await harness(undefined, { movieObjects, index });
      expect(profile(regsOf(plain, 'pgRegs'))).toEqual(profile(expected));
      expect(profile(regsOf(nav, 'navRegs'))).toEqual(profile(expected));
      expect(regsOf(nav, 'navRegs').psrRead(31)).not.toBe(profile(new RegisterFile())[2]);
    });

    it('applies the 3D profile to a 0200 index with content', async () => {
      const expected = new RegisterFile();
      expected.psrInit3D(1, false);
      const index = { ...hdmvIndex, appInfo: { initialOutputModePreference: 1, contentExistFlag: true } };
      const plain = await harness(undefined, { index });
      const nav = await harness(undefined, { movieObjects, index });
      expect(profile(regsOf(plain, 'pgRegs'))).toEqual(profile(expected));
      expect(profile(regsOf(nav, 'navRegs'))).toEqual(profile(expected));
    });

    it('keeps the disc ID only for BD-J discs', async () => {
      const id = new Uint8Array(60);
      id.set([...'BDID0200'].map((c) => c.charCodeAt(0)));
      id.fill(0xab, 44, 60);
      const bdjIndex: IndexSpec = { firstPlay: { kind: 'bdj', name: '00000' }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [] };
      const discId = (h: Harness): unknown => (h.player as unknown as { bdjDiscId: unknown }).bdjDiscId;
      const extraFiles = { 'CERTIFICATE/ID.BDMV': id };
      expect(discId(await harness(undefined, { extraFiles }))).toBeNull();
      expect(discId(await harness(undefined, { index: bdjIndex, extraFiles }))).toBe('ab'.repeat(16));
      expect(discId(await harness(undefined, { index: bdjIndex }))).toBeNull();
    });
  });

  type Internals = { navRegs: { psrRead(i: number): number }; navigator: { processHdmvVmEvent(e: unknown): void }; navNextMark: number; session: unknown; syncNavigator(s: unknown): void };
  const internals = (h: Harness): Internals => h.player as unknown as Internals;

  it('updates the chapter PSR at once on a user seek, backwards too', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
    await untilPlaying(h);
    expect(internals(h).navRegs.psrRead(5)).toBe(1);
    await h.player.handle({ type: 'seek', timeUs: 3_500_000 });
    expect(internals(h).navRegs.psrRead(5)).toBe(4);
    await h.player.handle({ type: 'seek', timeUs: 1_500_000 });
    expect(internals(h).navRegs.psrRead(5)).toBe(2); // not left at the later chapter
    await h.player.handle({ type: 'prevChapter' });
    expect(internals(h).navRegs.psrRead(5)).toBe(1);
    await h.player.handle({ type: 'nextChapter' });
    expect(internals(h).navRegs.psrRead(5)).toBe(2);
  });

  it('reports no marks while a seek asked for by the program is still queued', async () => {
    const reached = vi.spyOn(Navigator.prototype, 'markReached');
    try {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
      await untilPlaying(h);
      await h.play(1300);
      const me = internals(h);
      reached.mockClear();
      me.navNextMark = 1; // as if the old position had a mark due
      me.navigator.processHdmvVmEvent({ type: 7, param: 0, param2: 0 }); // PLAY_PI 0: queues a seek to the start
      me.syncNavigator(me.session);
      expect(reached).not.toHaveBeenCalled();
      await h.play(100);
      me.navNextMark = 0; // the clock is back near 0 after the seek, mark 0 is due
      me.syncNavigator(me.session);
      expect(reached).toHaveBeenCalled(); // the seek ran, reporting is back
    } finally {
      reached.mockRestore();
    }
  });

  const twoLanguages = [lpcmStream(0x1100, 4, { lang: 'jpn' }), lpcmStream(0x1101, 4, { lang: 'eng' })];

  it('routes a user audio change through PSR1', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { audioStreams: twoLanguages });
    await untilPlaying(h);
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(selectedAudio(h)).toBe(2);
  });

  it('refuses a user audio change while primaryAudioChange is masked', async () => {
    const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], {
      audioStreams: twoLanguages,
      playlists: [{ id: '00000', clipIds: ['00001'], uoMask: [0, 0, 0x04, 0, 0, 0, 0, 0] }],
    });
    await untilPlaying(h);
    expect(h.events).toContainEqual({ type: 'uoMask', masked: ['primaryAudioChange'] });
    await h.player.handle({ type: 'selectAudio', index: 2 });
    expect(selectedAudio(h)).toBe(1);
  });

  describe('UO masks', () => {
    const masked = (h: Harness) => h.events.filter((e) => e.type === 'notice' && e.code === 'uo-masked');
    /** First Play plays 00000 with the given 8-byte playlist UO mask table. */
    const maskedPlaylist = async (uoMask: number[]) => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { playlists: [{ id: '00000', clipIds: ['00001'], uoMask, chapterEverySeconds: 1 }] });
      await untilPlaying(h);
      return h;
    };

    it('refuses a seek while timeSearch is masked: a notice, no seek, no buffering', async () => {
      const h = await maskedPlaylist([0x10, 0, 0, 0, 0, 0, 0, 0]);
      await h.play(500);
      const before = lastTelemetry(h)!.clockUs;
      const statesBefore = states(h).length;
      await h.player.handle({ type: 'seek', timeUs: 3_000_000 });
      await h.play(600);
      expect(masked(h)).toEqual([{ type: 'notice', code: 'uo-masked', message: "The disc doesn't allow this here." }]);
      expect(states(h).slice(statesBefore)).not.toContain('buffering');
      const after = lastTelemetry(h)!.clockUs;
      expect(after).toBeGreaterThan(before);
      expect(after).toBeLessThan(2_500_000);
    });

    it('refuses pause while pauseOn is masked and keeps playing', async () => {
      const h = await maskedPlaylist([0, 0x80, 0, 0, 0, 0, 0, 0]);
      await h.player.handle({ type: 'pause' });
      expect(masked(h)).toHaveLength(1);
      expect(lastState(h)).toBe('playing');
    });

    it('refuses next chapter while skipToNextPoint is masked', async () => {
      const h = await maskedPlaylist([0x08, 0, 0, 0, 0, 0, 0, 0]);
      await h.player.handle({ type: 'nextChapter' });
      expect(masked(h)).toHaveLength(1);
      expect(internals(h).navRegs.psrRead(5)).toBe(1);
    });

    it('tells the user when an audio change is refused', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], {
        audioStreams: twoLanguages,
        playlists: [{ id: '00000', clipIds: ['00001'], uoMask: [0, 0, 0x04, 0, 0, 0, 0, 0] }],
      });
      await untilPlaying(h);
      await h.player.handle({ type: 'selectAudio', index: 2 });
      expect(masked(h)).toHaveLength(1);
    });

    it('allows everything on a disc without a navigator', async () => {
      const h = await harness(CodingType.LPCM);
      await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
      await untilPlaying(h);
      await h.player.handle({ type: 'pause' });
      expect(masked(h)).toEqual([]);
    });
  });

  describe('review fixes', () => {
    const noticeCodes = (h: Harness) => h.events.flatMap((e) => (e.type === 'notice' ? [e.code] : []));

    it('keeps a held still frozen on the audio clock', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { playlists: [{ id: '00000', clipIds: ['00001'], stills: { 0: { mode: 2 } } }] });
      await untilPlaying(h);
      await h.play(4500);
      await h.play(1000);
      const frozen = lastTelemetry(h)?.clockUs;
      expect(frozen).toBeGreaterThan(3_900_000);
      expect(frozen).toBeLessThan(4_000_000);
      await h.play(2000, { audio: false }); // a suspended output: the worklet does not run, which is no stall while held
      expect(lastTelemetry(h)?.clockUs).toBe(frozen);
      expect(lastTelemetry(h)?.clockMode).toBe('audio');
      expect(noticeCodes(h)).not.toContain('audio-disabled');
    });

    it('reports the end of a time still once and moves on to the next item', async () => {
      const ended = vi.spyOn(Navigator.prototype, 'playItemEnded');
      const changed = vi.spyOn(Navigator.prototype, 'playItemChanged');
      try {
        const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle], { playlists: [{ id: '00000', clipIds: ['00001', '00002'], stills: { 0: { mode: 1, time: 1 } } }] });
        await untilPlaying(h);
        await h.play(7500);
        expect(ended.mock.calls.filter(([i]) => i === 0)).toHaveLength(1);
        expect(changed.mock.calls.map(([i]) => i)).toEqual([1]);
        expect(lastTelemetry(h)?.clockUs).toBeGreaterThan(4_500_000);
      } finally {
        ended.mockRestore();
        changed.mockRestore();
      }
    });

    it('does not start a playlist whose open was cancelled while loading', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(0))] }, idle, idle]);
      await h.player.handle({ type: 'playTitle', title: 1 }); // jumping to an object stops the playlist that is still loading
      await h.play(500);
      expect(chapterIds(h)).toEqual([]);
      expect(lastState(h)).toBe('idle');
    });

    it('treats a playlist with a missing clip as invalid and lets the program continue', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(1)), asm.playPl(imm(0))] }, idle, idle], { dropFiles: ['BDMV/CLIPINF/00002.clpi'] });
      await untilPlaying(h);
      expect(chapterIds(h)).toEqual(['00000']);
      expect(h.events.some((e) => e.type === 'error' && e.code === 'internal')).toBe(false);
    });

    it('reports an unsupported codec of a program-started playlist as for a picked one', async () => {
      const h = await nav([{ cmds: [asm.playPl(imm(1))] }, idle, idle], {
        playlists: [
          { id: '00000', clipIds: ['00001'] },
          { id: '00001', clipIds: ['00002'], videoCodingType: CodingType.VC1 },
        ],
      });
      await h.play(300);
      expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'video' }));
      expect(h.events.some((e) => e.type === 'error' && e.code === 'internal')).toBe(false);
    });
  });
});

// ---- subtitles ----

const EMPTY = new OverlayPlane().hash();
const subtitleEvents = (h: Harness) => h.events.flatMap((e) => (e.type === 'subtitles' ? [e] : []));
const visibleAt = (h: Harness, x: number) => (h.pgDraws.at(-1)?.rgba({ x, y: 900, w: 1, h: 1 })[3] ?? 0) === 255;
/** The timestamp of the last video frame drawn: the presentation time (telemetry lags by up to 500 ms). */
const clockUs = (h: Harness) => h.drawn.at(-1) ?? 0;
/** Steps simulated time one render tick at a time (vi.waitFor would wait 50 ms between ticks) until `done`, at most 10 s. */
async function stepUntil(h: Harness, done: () => boolean): Promise<void> {
  for (let ms = 0; !done(); ms += STEP_MS) {
    if (ms > 10_000) throw new Error('condition not reached within 10 s of playback');
    await h.play(STEP_MS);
  }
}
const playUntil = (h: Harness, us: number) => stepUntil(h, () => clockUs(h) >= us);
/** Plays until a telemetry sample taken in [fromUs, toUs) arrives. */
async function telemetryBetween(h: Harness, fromUs: number, toUs: number): Promise<Telemetry> {
  await stepUntil(h, () => (lastTelemetry(h)?.clockUs ?? 0) >= fromUs);
  const t = lastTelemetry(h)!;
  expect(t.clockUs).toBeLessThan(toUs);
  return t;
}
const pgTelemetryBetween = async (h: Harness, fromUs: number, toUs: number): Promise<Telemetry['pg']> => (await telemetryBetween(h, fromUs, toUs)).pg;

describe('Player PG subtitles', () => {
  const at = (seconds: number, segs: Uint8Array[]) => segs.map((payload) => ({ pts: CLIP_START_PTS + Math.round(seconds * 90_000), payload }));
  /** Stream 1 (eng): 1.0–2.0 s at x 100, a forced caption 2.5–2.9 s at x 200, 3.0–3.5 s at x 300. Stream 2 (jpn): 1.1–3.9 s at x 500. */
  const pgStreams: SyntheticPgStream[] = [
    { pid: 0x1200, lang: 'eng', units: [
      ...at(1, subtitleSegments({ x: 100 })), ...at(2, clearSegments(1)),
      ...at(2.5, subtitleSegments({ x: 200, forced: true, compositionNumber: 2 })), ...at(2.9, clearSegments(3)),
      ...at(3, subtitleSegments({ x: 300, compositionNumber: 4 })), ...at(3.5, clearSegments(5)),
    ] },
    { pid: 0x1201, lang: 'jpn', units: [...at(1.1, subtitleSegments({ x: 500 })), ...at(3.9, clearSegments(1))] },
  ];
  async function raw(): Promise<Harness> {
    const h = await harness(CodingType.LPCM, { pgStreams });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    return h;
  }

  it('shows a picked stream at its time on a disc without a navigator, and lists the tracks', async () => {
    const h = await raw();
    expect(subtitleEvents(h).at(-1)).toEqual({ type: 'subtitles', pg: [{ index: 1, language: 'eng' }, { index: 2, language: 'jpn' }], text: null, selected: 'off', scale: 1 });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    expect(subtitleEvents(h).at(-1)!.selected).toEqual({ pg: 1 });
    expect(await pgTelemetryBetween(h, 1_000_000, 2_000_000)).toEqual({ objectsShown: 1, forced: 0 });
    await playUntil(h, 1_300_000);
    expect(visibleAt(h, 100)).toBe(true);
    await playUntil(h, 2_050_000);
    expect(h.pgDraws.at(-1)!.hash()).toBe(EMPTY);
    expect(await pgTelemetryBetween(h, 2_000_000, 2_500_000)).toEqual({ objectsShown: 0, forced: 0 });
    expect(lastTelemetry(h)!.pgErrors).toBe(0);
  });

  it('a seek clears the subtitle at once and the next one after the target appears', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await playUntil(h, 1_300_000);
    expect(visibleAt(h, 100)).toBe(true);
    await h.player.handle({ type: 'seek', timeUs: 2_050_000 });
    await h.play(STEP_MS);
    expect(h.pgDraws.at(-1)!.hash()).toBe(EMPTY);
    await untilPlaying(h);
    await playUntil(h, 3_100_000);
    expect(visibleAt(h, 300)).toBe(true);
    expect(visibleAt(h, 100)).toBe(false);
  });

  it('switching streams drops the old subtitle at once and shows the new stream\'s current one', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await playUntil(h, 1_300_000);
    expect(visibleAt(h, 100)).toBe(true);
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 2 } });
    await h.play(STEP_MS);
    expect(h.pgDraws.at(-1)!.hash()).toBe(EMPTY);
    expect(subtitleEvents(h).at(-1)!.selected).toEqual({ pg: 2 });
    const switchedAt = clockUs(h);
    await stepUntil(h, () => visibleAt(h, 500));
    expect(clockUs(h) - switchedAt).toBeLessThan(1_000_000);
  });

  it('stops drawing the PG plane every frame once its subtitle is cleared', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await playUntil(h, 1_300_000);
    const shown = h.pgDraws.length;
    await playUntil(h, 1_800_000);
    expect(h.pgDraws.length).toBeGreaterThan(shown + 10); // drawn with every frame while it is up
    await playUntil(h, 2_100_000); // the clear set at 2 s
    const cleared = h.pgDraws.length;
    await playUntil(h, 2_450_000);
    expect(h.pgDraws.length).toBe(cleared);
  });

  it('with subtitles off shows forced captions only', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'off' } });
    expect(await pgTelemetryBetween(h, 1_000_000, 2_000_000)).toEqual({ objectsShown: 0, forced: 0 });
    expect(visibleAt(h, 100)).toBe(false);
    expect(await pgTelemetryBetween(h, 2_500_000, 2_900_000)).toEqual({ objectsShown: 1, forced: 1 });
    await playUntil(h, 2_600_000);
    expect(visibleAt(h, 200)).toBe(true);
    await playUntil(h, 3_200_000);
    expect(visibleAt(h, 300)).toBe(false);
  });

  it('follows the disc program\'s registers with a navigator and refuses a masked change', async () => {
    const idle = { cmds: [] };
    const h = await harness(CodingType.LPCM, {
      pgStreams,
      movieObjects: buildMovieObjects([{ cmds: [asm.playPl(imm(0))] }, idle, idle]),
      playlists: [{ id: '00000', clipIds: ['00001'], uoMask: [0, 0, 0, 0x10, 0, 0, 0, 0] }],
    });
    await untilPlaying(h);
    expect(subtitleEvents(h).at(-1)!.selected).toBe('off');
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 2 } });
    expect(h.events).toContainEqual({ type: 'notice', code: 'uo-masked', message: "The disc doesn't allow this here." });
    expect(subtitleEvents(h).at(-1)!.selected).toBe('off');
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } }); // only the display flag: allowed
    expect(subtitleEvents(h).at(-1)!.selected).toEqual({ pg: 1 });
    await playUntil(h, 1_300_000);
    expect(visibleAt(h, 100)).toBe(true);
  });

  it('clears the plane and forgets the stream when the disc is closed', async () => {
    const h = await raw();
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await playUntil(h, 1_300_000);
    const plane = h.pgDraws.at(-1)!;
    await h.player.handle({ type: 'close' });
    expect(plane.hash()).toBe(EMPTY);
  });
});

/** ASS dependencies for Node: fonts registered by a fake loader that can be held back, glyphs measured by a fixed ratio. */
function fakeAssDeps(gate?: Promise<void>): NonNullable<PlayerDeps['createAssDeps']> {
  return async () => ({
    loader: { load: async () => { await gate; }, unload: () => undefined },
    defaultFont: await readFontFile('DejaVuSans.ttf', new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf'))),
    measurer: createFixedMeasurer(0.5),
    createCanvas: () => ({}) as OffscreenCanvas,
    Path2D: class {} as unknown as typeof Path2D,
  });
}

describe('Player text subtitles', () => {
  /** Cues at 1–2 s and 5–6 s of playlist time. */
  const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:05,000 --> 00:00:06,000\nLater\n';
  const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
  const file = (name: string, text: string) => ({ name, bytes: bytes(text) });
  const notices = (h: Harness) => h.events.filter((e) => e.type === 'notice' && e.code === 'subtitle-file');
  const fontNotices = (h: Harness) => h.events.filter((e) => e.type === 'notice' && e.code === 'subtitle-fonts');
  const fontFile = (name: string, path = 'fixtures/ass/fonts/DejaVuSans.ttf') => ({ name, bytes: new Uint8Array(readFileSync(path)).buffer as ArrayBuffer });
  const ass = (font: string, ...events: string[]) => `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,40,40,50,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
  const dialogue = (from: string, to: string, text: string) => `Dialogue: 0,${from},${to},Default,,0,0,0,,${text}`;
  async function raw(opts: Parameters<typeof harness>[1] = {}): Promise<Harness> {
    const h = await harness(CodingType.LPCM, opts);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    return h;
  }
  const lastText = (h: Harness) => subtitleEvents(h).at(-1)!.text;

  it('loads a file, selects it, and reports a visible cue only during its time', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    expect(subtitleEvents(h).at(-1)).toEqual({ type: 'subtitles', pg: [], text: { files: [{ name: 'movie.srt', format: 'srt', cues: 2, startUs: 0, offsetMs: 0 }], missingFonts: [], episodeStarts: [0, 4_000_000] }, selected: 'text', scale: 1 });
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).textCue).toBe(true);
    expect((await telemetryBetween(h, 2_000_000, 5_000_000)).textCue).toBe(false);
  });

  it('asks once for an encoding for the files of a load that are not UTF-8, and loads them with the one given', async () => {
    const h = await raw();
    const latin = Uint8Array.from([...SRT.replace('Hello', 'Café')].map((c) => c.charCodeAt(0))).buffer as ArrayBuffer;
    await h.player.handle({ type: 'addTextSubtitles', files: [{ name: 'latin.srt', bytes: latin.slice(0) }, file('ok.srt', SRT)] });
    expect(h.events).toContainEqual({ type: 'subtitleEncodingNeeded', names: ['latin.srt'] });
    expect(lastText(h) ?? null).toBeNull();
    await h.player.handle({ type: 'addTextSubtitles', files: [{ name: 'latin.srt', bytes: latin }, file('ok.srt', SRT)], encoding: 'windows-1252' });
    expect(lastText(h)!.files.map((f) => f.name)).toEqual(['latin.srt', 'ok.srt']);
  });

  it('leaves out files without cues with a notice naming them, and keeps the old set when none is readable', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await h.player.handle({ type: 'addTextSubtitles', files: [file('empty.srt', 'not subtitles at all')] });
    expect(notices(h).at(-1)).toEqual({ type: 'notice', code: 'subtitle-file', message: 'empty.srt: this file has no subtitles we can read' });
    expect(lastText(h)!.files.map((f) => f.name)).toEqual(['movie.srt']);
    await h.player.handle({ type: 'addTextSubtitles', files: [file('bad.srt', '1\nnope\nx\n\n2\nnope\ny\n\n3\n00:00:01,000 --> 00:00:02,000\nok')] });
    expect(notices(h).at(-1)).toEqual({ type: 'notice', code: 'subtitle-file', message: 'Some lines of this file could not be read' });
    expect(lastText(h)!.files).toEqual([{ name: 'bad.srt', format: 'srt', cues: 1, startUs: 0, offsetMs: 0 }]);
  });

  it('shifts a file by its own offset and clamps offset and size', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await h.player.handle({ type: 'setSubtitleOffset', file: 0, ms: 1000 });
    expect(lastText(h)!.files[0]!.offsetMs).toBe(1000);
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).textCue).toBe(false);
    expect((await telemetryBetween(h, 2_000_000, 3_000_000)).textCue).toBe(true);
    await h.player.handle({ type: 'setSubtitleOffset', file: 0, ms: -9_999_999 });
    expect(lastText(h)!.files[0]!.offsetMs).toBe(-600_000);
    await h.player.handle({ type: 'setSubtitleScale', scale: 7 });
    expect(subtitleEvents(h).at(-1)!.scale).toBe(2);
    await h.player.handle({ type: 'setSubtitleScale', scale: 0.1 });
    expect(subtitleEvents(h).at(-1)!.scale).toBe(0.5);
  });

  it('hides the text when a PG stream or Off is picked, and removes the track', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'off' } });
    expect(subtitleEvents(h).at(-1)!.selected).toBe('off');
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).textCue).toBe(false);
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'text' } });
    expect(subtitleEvents(h).at(-1)!.selected).toBe('text');
    await h.player.handle({ type: 'removeTextSubtitle' });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ text: null, selected: 'off' });
  });

  it('a PG pick hides the text track, and picking the text again turns PG\'s display flag off', async () => {
    const pgStreams: SyntheticPgStream[] = [{ pid: 0x1200, lang: 'eng', units: subtitleSegments({}).map((payload) => ({ pts: CLIP_START_PTS + 3 * 90_000, payload })) }];
    const h = await raw({ pgStreams });
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    expect(subtitleEvents(h).at(-1)!.selected).toEqual({ pg: 1 });
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).textCue).toBe(false);
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'text' } });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ selected: 'text', pg: [{ index: 1, language: 'eng' }] });
    expect((await telemetryBetween(h, 3_000_000, 4_000_000)).pg).toEqual({ objectsShown: 0, forced: 0 }); // the PG line is not forced
  });

  it('keeps the track across the program\'s playlists and a raw pick, and drops it with the disc', async () => {
    const idle = { cmds: [] };
    const h = await harness(CodingType.LPCM, {
      playlists: [{ id: '00000', clipIds: ['00001'] }, { id: '00001', clipIds: ['00002'] }],
      movieObjects: buildMovieObjects([{ cmds: [asm.playPl(imm(0)), asm.playPl(imm(1))] }, idle, idle]),
    });
    await untilPlaying(h);
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    await stepUntil(h, () => h.events.some((e) => e.type === 'chapters' && e.playlistId === '00001'));
    const switched = h.events.length;
    const sampleAfterSwitch = () => h.events.slice(switched).flatMap((e) => (e.type === 'telemetry' && e.telemetry.clockUs >= 1_000_000 ? [e.telemetry] : []))[0];
    await stepUntil(h, () => sampleAfterSwitch() !== undefined);
    expect(sampleAfterSwitch()!.clockUs).toBeLessThan(2_000_000); // the second playlist's own time
    expect(sampleAfterSwitch()!.textCue).toBe(true);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' }); // a raw pick: same disc
    expect(lastText(h)!.files.map((f) => f.name)).toEqual(['movie.srt']);
    await h.player.handle({ type: 'close' });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ text: null, pg: [] });
    const other = buildSyntheticDisc({ clips: [syntheticClip('00009', 2)], playlists: [{ id: '00009', clipIds: ['00009'] }] });
    await h.player.handle({ type: 'open', entries: discEntries(other) });
    expect(subtitleEvents(h).at(-1)).toMatchObject({ text: null, selected: 'off' });
  });

  it('places two files on the two play items and shows each in its own item', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('ep2.srt', SRT), file('ep1.srt', SRT)] });
    expect(lastText(h)!.files.map((f) => [f.name, f.startUs])).toEqual([['ep1.srt', 0], ['ep2.srt', 4_000_000]]);
    expect(await telemetryBetween(h, 1_000_000, 2_000_000)).toMatchObject({ textCue: true, textFile: 0 });
    expect(await telemetryBetween(h, 4_000_000, 5_000_000)).toMatchObject({ textCue: false, textFile: 1 });
    expect(await telemetryBetween(h, 5_000_000, 6_000_000)).toMatchObject({ textCue: true, textFile: 1 }); // file 2's cue at 1 s
  });

  it('places only the first of more files than episodes, with a notice, and moves a file by setSubtitleStart', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('a.srt', SRT), file('b.srt', SRT), file('c.srt', SRT)] });
    expect(lastText(h)!.files.map((f) => f.startUs)).toEqual([0, null, null]);
    expect(notices(h).at(-1)).toEqual({ type: 'notice', code: 'subtitle-file', message: "Place each subtitle file at its episode's start in the subtitle menu" });
    await h.player.handle({ type: 'setSubtitleStart', file: 1, startUs: 2_000_000 });
    expect(lastText(h)!.files.map((f) => f.startUs)).toEqual([0, 2_000_000, null]);
    await h.player.handle({ type: 'setSubtitleOffset', file: 1, ms: 200 });
    expect(lastText(h)!.files.map((f) => f.offsetMs)).toEqual([0, 200, 0]);
  });

  it('loads an ASS file with its font and reports no missing family', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('sign.ass', ass('DejaVu Sans', dialogue('0:00:01.00', '0:00:02.00', 'hi')))], fonts: [fontFile('DejaVuSans.ttf')] });
    expect(lastText(h)).toEqual({ files: [{ name: 'sign.ass', format: 'ass', cues: 1, startUs: 0, offsetMs: 0 }], missingFonts: [], episodeStarts: [0, 4_000_000] });
    expect(fontNotices(h)).toEqual([]);
    const t = await telemetryBetween(h, 1_000_000, 2_000_000);
    expect(t.textCue).toBe(true);
    expect(t.ass).not.toBeNull();
  });

  it('reports a missing family once, and clears it when the font is added', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('sign.ass', ass('DejaVu Serif', dialogue('0:00:01.00', '0:00:02.00', 'hi')))] });
    expect(lastText(h)!.missingFonts).toEqual(['DejaVu Serif']);
    expect(fontNotices(h)).toEqual([{ type: 'notice', code: 'subtitle-fonts', message: 'Some fonts are missing and were replaced: DejaVu Serif' }]);
    await h.player.handle({ type: 'addSubtitleFonts', fonts: [fontFile('DejaVuSerif.ttf', 'fixtures/ass/fonts/DejaVuSerif.ttf')] });
    expect(lastText(h)!.missingFonts).toEqual([]);
    expect(fontNotices(h)).toHaveLength(1);
  });

  it('names unreadable font files', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('sign.ass', ass('DejaVu Sans', dialogue('0:00:01.00', '0:00:02.00', 'hi')))], fonts: [{ name: 'broken.ttf', bytes: new ArrayBuffer(10) }] });
    expect(fontNotices(h)).toContainEqual({ type: 'notice', code: 'subtitle-fonts', message: 'Some font files could not be read: broken.ttf' });
  });

  it('drops a load whose fonts are still loading when the disc closes or another load starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await raw({ createAssDeps: fakeAssDeps(gate) });
    const first = h.player.handle({ type: 'addTextSubtitles', files: [file('one.ass', ass('DejaVu Sans', dialogue('0:00:01.00', '0:00:02.00', 'one')))] });
    await new Promise((r) => setTimeout(r, 0));
    const second = h.player.handle({ type: 'addTextSubtitles', files: [file('two.srt', SRT)] });
    release();
    await Promise.all([first, second]);
    expect(lastText(h)!.files.map((f) => f.name)).toEqual(['two.srt']);
    const late = h.player.handle({ type: 'addTextSubtitles', files: [file('three.ass', ass('DejaVu Sans', dialogue('0:00:01.00', '0:00:02.00', 'x')))] });
    await h.player.handle({ type: 'close' });
    await late;
    expect(subtitleEvents(h).at(-1)!.text).toBeNull();
  });

  it('treats an unrecognised file as unreadable, and reports no ASS telemetry for SRT', async () => {
    const h = await raw();
    await h.player.handle({ type: 'addTextSubtitles', files: [file('x.ass', '[Script Info]\nnothing else\n')] });
    expect(notices(h).at(-1)).toEqual({ type: 'notice', code: 'subtitle-file', message: 'x.ass: this file has no subtitles we can read' });
    await h.player.handle({ type: 'addTextSubtitles', files: [file('movie.srt', SRT)] });
    expect((await telemetryBetween(h, 1_000_000, 2_000_000)).ass).toBeNull();
  });
});


describe('Player video shaders', () => {
  const PASS = '//!HOOK MAIN\n//!BIND HOOKED\nvec4 hook() { return HOOKED_tex(HOOKED_pos); }\n';
  const setA: ShaderSetData = { name: 'A', files: [{ name: 'a.glsl', source: PASS }] };

  /** Compiles when `finish()` is called; renders a sentinel image. */
  function fakeShaders() {
    const pending: Array<() => void> = [];
    const created: Array<{ lost(): void; restored(): void }> = [];
    const image = { shaded: true } as unknown as OffscreenCanvas;
    const backend: ShaderBackend = {
      compile: (passes) => new Promise<CompiledSet>((resolve) => pending.push(() => resolve({ passes, dispose: () => undefined }))),
      render: (set) => ({ image, passesRun: set.passes.length, gpuMs: null }),
    };
    return {
      created,
      createShaderBackend: (events: { lost(): void; restored(): void }) => {
        created.push(events);
        return backend;
      },
      finish: async () => {
        for (const p of pending.splice(0)) p();
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  }
  const shaderStatuses = (events: EngineEvent[]) => events.flatMap((e) => (e.type === 'shaderStatus' ? [e] : []));

  it('creates the backend only when a set is chosen, and hands a set chosen before the canvas to the compositor', async () => {
    const shaders = fakeShaders();
    const events: EngineEvent[] = [];
    const stages: Array<ShaderStage | null> = [];
    const player = new Player({
      emit: (e) => events.push(e), videoCodecApi: fakeApi, nowMs: () => 0, requestFrame: () => undefined, createAudioDecoder: noWasmFactory,
      createShaderBackend: shaders.createShaderBackend,
      createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined, setShaderStage: (s) => stages.push(s) }),
    });
    await player.handle({ type: 'setVideoShaders', set: null });
    expect(shaders.created).toHaveLength(0);
    expect(shaderStatuses(events)).toEqual([{ type: 'shaderStatus', state: 'off', set: null, error: null }]);
    await player.handle({ type: 'setVideoShaders', set: setA });
    expect(shaders.created).toHaveLength(1);
    expect(shaderStatuses(events).at(-1)).toEqual({ type: 'shaderStatus', state: 'compiling', set: 'A', error: null });
    await shaders.finish();
    expect(shaderStatuses(events).at(-1)).toEqual({ type: 'shaderStatus', state: 'active', set: 'A', error: null });
    await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
    expect(stages).toHaveLength(1);
    expect(stages[0]).toBeInstanceOf(ShaderStage);
    await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
    expect(stages).toHaveLength(2);
    expect(stages[1]).toBe(stages[0]);
  });

  it('reports unavailable when the browser has no backend', async () => {
    const h = await harness(CodingType.LPCM, { createShaderBackend: () => 'no WebGL2 here' });
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    expect(shaderStatuses(h.events)).toEqual([{ type: 'shaderStatus', state: 'unavailable', set: 'A', error: 'no WebGL2 here' }]);
  });

  it('reports unavailable when the backend factory throws', async () => {
    const h = await harness(CodingType.LPCM, {
      createShaderBackend: () => {
        throw new Error('OffscreenCanvas failed');
      },
    });
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    expect(shaderStatuses(h.events)).toEqual([{ type: 'shaderStatus', state: 'unavailable', set: 'A', error: UNAVAILABLE }]);
    expect(h.events.some((e) => e.type === 'state' && e.state === 'error')).toBe(false);
  });

  it('reports unavailable without a backend factory', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    expect(shaderStatuses(h.events).at(-1)).toMatchObject({ state: 'unavailable', set: 'A' });
  });

  it('keeps the chosen set across closing and opening a disc, and reports it in telemetry', async () => {
    const shaders = fakeShaders();
    const h = await harness(CodingType.LPCM, { createShaderBackend: shaders.createShaderBackend });
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    await shaders.finish();
    expect(h.shaderStages).toHaveLength(1);
    await h.player.handle({ type: 'close' });
    await h.player.handle({ type: 'open', entries: h.entries });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(600); // a telemetry sample after frames were drawn
    expect(h.shaderStages).toEqual([expect.any(ShaderStage)]);
    expect(shaderStatuses(h.events).map((e) => e.state)).toEqual(['compiling', 'active']);
    expect(lastTelemetry(h)!.shader).toEqual({ set: 'A', passesRun: 1, gpuMs: null });
    await h.player.handle({ type: 'setVideoShaders', set: null });
    await h.play(600);
    expect(lastTelemetry(h)!.shader).toBeNull();
  });

  it('activates a set whose compile finishes after the disc closed, and shades the next disc', async () => {
    const shaders = fakeShaders();
    const h = await harness(CodingType.LPCM, { createShaderBackend: shaders.createShaderBackend });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    await h.player.handle({ type: 'close' });
    await shaders.finish(); // no session, no current frame
    expect(shaderStatuses(h.events).at(-1)).toMatchObject({ state: 'active', set: 'A' });
    h.order.length = 0;
    expect(() => h.player.tick()).not.toThrow();
    expect(h.order).toEqual([]);
    await h.player.handle({ type: 'open', entries: h.entries });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(600);
    expect(h.order.some((o) => o !== 'video:null')).toBe(true);
    expect(lastTelemetry(h)!.shader).toEqual({ set: 'A', passesRun: 1, gpuMs: null });
  });

  it('repaints the paused frame and its overlays once the set is ready', async () => {
    const shaders = fakeShaders();
    const at = (seconds: number, segs: Uint8Array[]) => segs.map((payload) => ({ pts: CLIP_START_PTS + Math.round(seconds * 90_000), payload }));
    const h = await harness(CodingType.LPCM, { createShaderBackend: shaders.createShaderBackend, pgStreams: [{ pid: 0x1200, lang: 'eng', units: at(1, subtitleSegments({ x: 100 })) }] });
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await h.player.handle({ type: 'selectSubtitle', choice: { kind: 'pg', stream: 1 } });
    await untilPlaying(h);
    await stepUntil(h, () => clockUs(h) >= 1_300_000);
    await h.player.handle({ type: 'pause' });
    await h.play(200);
    const current = h.drawn.at(-1);
    h.order.length = 0;
    await h.player.handle({ type: 'setVideoShaders', set: setA });
    h.player.tick();
    expect(h.order).toEqual([]); // compiling: nothing to repaint yet
    await shaders.finish();
    h.player.tick();
    expect(h.order).toEqual([`video:${current}`, 'pg']);
    h.order.length = 0;
    h.player.tick();
    expect(h.order).toEqual([]);
  });
});
