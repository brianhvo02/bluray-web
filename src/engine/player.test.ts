import { describe, expect, it, vi } from 'vitest';
import { buildSyntheticDisc, discEntries, syntheticClip } from '../../tests/helpers/synthetic-disc';
import { createRing, renderQuantum, ringViews, type RingViews } from './audio/ring';
import { CodingType } from './bdmv/stream-types';
import type { VideoCodecApi, VideoDecoderLike } from './decode/video-decoder';
import { Player } from './player';
import type { EngineEvent, PlaybackState, Telemetry } from './protocol';

class FakeDecoder implements VideoDecoderLike {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  constructor(private readonly init: VideoDecoderInit) {}
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
  /** Advance simulated time; the fake worklet consumes audio unless audio: false; ticks unless render: false. */
  play(ms: number, opts?: { render?: boolean; audio?: boolean }): Promise<void>;
}

async function harness(audio: number | undefined): Promise<Harness> {
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', 4, { audio }), syntheticClip('00002', 4, { audio })],
    playlists: [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2 }],
  });
  const events: EngineEvent[] = [];
  const drawn: number[] = [];
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeApi,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createCompositor: () => ({
      resize: () => undefined,
      drawVideo: (f) => {
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

  it('reports a folder without BDMV', async () => {
    const events: EngineEvent[] = [];
    const player = new Player({ emit: (e) => events.push(e), videoCodecApi: fakeApi, nowMs: () => 0, requestFrame: () => undefined, createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }) });
    await player.handle({ type: 'open', entries: [['Stuff/readme.txt', new Blob(['hi'])]] });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'not-bdmv' }));
    expect(events.at(-1)).toEqual({ type: 'state', state: 'error' });
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

  it('jumps to the next chapter', async () => {
    const h = await harness(CodingType.LPCM);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.player.handle({ type: 'nextChapter' });
    expect(h.events).toContainEqual({ type: 'time', timeUs: 2_000_000 });
  });

  it('reaches the ended state at the end of the playlist', async () => {
    const h = await harness(CodingType.AC3);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await untilPlaying(h);
    await h.play(8500);
    expect(lastState(h)).toBe('ended');
  });
});
