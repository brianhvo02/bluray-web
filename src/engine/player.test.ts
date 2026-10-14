import { describe, expect, it, vi } from 'vitest';
import { asm, buildMovieObjects, imm } from '../../tests/helpers/hdmv-builders';
import { buildSyntheticDisc, discEntries, dummyAudioStream, lpcmStream, syntheticClip, type SyntheticAudioStream, type SyntheticPlaylistSpec } from '../../tests/helpers/synthetic-disc';
import { Control, createRing, renderQuantum, ringViews, type RingViews } from './audio/ring';
import { CodingType } from './bdmv/stream-types';
import { createAudioDecoderFactory, type AudioDecoderFactory } from './decode/audio-decoder';
import type { VideoCodecApi, VideoDecoderLike } from './decode/video-decoder';
import { Navigator } from './nav/navigator';
import { Player } from './player';
import type { EngineEvent, PlaybackState, Telemetry } from './protocol';

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
  /** Callbacks the engine registered with requestFrame. */
  frames: Array<() => void>;
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

async function harness(audio: number | undefined, opts: { corruptAudioPesIndex?: number; videoCodingType?: number; throwOnDraw?: boolean; audioMuxLag90k?: number; frameBytes?: number; playlists?: SyntheticPlaylistSpec[]; audioStreams?: SyntheticAudioStream[]; secondClipAudioStreams?: SyntheticAudioStream[]; createAudioDecoder?: AudioDecoderFactory; movieObjects?: Uint8Array<ArrayBuffer>; dropFiles?: string[] } = {},
): Promise<Harness> {
  decoders.length = 0;
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', 4, { audio, corruptAudioPesIndex: opts.corruptAudioPesIndex, frameBytes: opts.frameBytes, audioStreams: opts.audioStreams }), syntheticClip('00002', 4, { audio, audioMuxLag90k: opts.audioMuxLag90k, frameBytes: opts.frameBytes, audioStreams: opts.secondClipAudioStreams ?? opts.audioStreams })],
    playlists: opts.playlists ?? [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2, videoCodingType: opts.videoCodingType }],
    movieObjects: opts.movieObjects,
  });
  for (const f of opts.dropFiles ?? []) files.delete(f);
  const events: EngineEvent[] = [];
  const drawn: number[] = [];
  const frames: Array<() => void> = [];
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeApi,
    nowMs: () => clock.ms,
    requestFrame: (cb) => frames.push(cb),
    createAudioDecoder: opts.createAudioDecoder ?? noWasmFactory,
    createCompositor: () => ({
      resize: () => undefined,
      drawVideo: (f) => {
        if (f && opts.throwOnDraw) throw new Error('draw exploded');
        if (f) drawn.push(f.timestamp);
      },
    }),
  });
  const ring = createRing(48_000, 2);
  const views: RingViews = ringViews(ring);
  await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  await player.handle({ type: 'open', entries: discEntries(files) });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    player,
    events,
    drawn,
    frames,
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
