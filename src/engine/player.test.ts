import { describe, expect, it, vi } from 'vitest';
import { buildSyntheticDisc, discEntries, syntheticClip, type SyntheticPlaylistSpec } from '../../tests/helpers/synthetic-disc';
import { createRing, renderQuantum, ringViews, type RingViews } from './audio/ring';
import { CodingType } from './bdmv/stream-types';
import type { VideoCodecApi, VideoDecoderLike } from './decode/video-decoder';
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
  /** Advance simulated time; the fake worklet consumes audio unless audio: false; ticks unless render: false. */
  play(ms: number, opts?: { render?: boolean; audio?: boolean }): Promise<void>;
}

async function harness(audio: number | undefined, opts: { corruptAudioPesIndex?: number; videoCodingType?: number; throwOnDraw?: boolean; audioMuxLag90k?: number; frameBytes?: number; playlists?: SyntheticPlaylistSpec[] } = {},
): Promise<Harness> {
  decoders.length = 0;
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', 4, { audio, corruptAudioPesIndex: opts.corruptAudioPesIndex, frameBytes: opts.frameBytes }), syntheticClip('00002', 4, { audio, audioMuxLag90k: opts.audioMuxLag90k, frameBytes: opts.frameBytes })],
    playlists: opts.playlists ?? [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2, videoCodingType: opts.videoCodingType }],
  });
  const events: EngineEvent[] = [];
  const drawn: number[] = [];
  const frames: Array<() => void> = [];
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeApi,
    nowMs: () => clock.ms,
    requestFrame: (cb) => frames.push(cb),
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

  it('reports a folder without BDMV', async () => {
    const events: EngineEvent[] = [];
    const player = new Player({ emit: (e) => events.push(e), videoCodecApi: fakeApi, nowMs: () => 0, requestFrame: () => undefined, createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }) });
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
    const h = await harness(CodingType.AC3);
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
    const h = await harness(CodingType.AC3);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'unsupported', kind: 'audio', codec: 'Dolby Digital (AC-3)' }));
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
    const h = await harness(CodingType.AC3);
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
});
