import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { storedZip } from '../../tests/helpers/jvm-asm';
import { asm, buildMovieObjects, imm } from '../../tests/helpers/hdmv-builders';
import { buildSyntheticDisc, discEntries, lpcmStream, syntheticClip, type SyntheticDiscSpec } from '../../tests/helpers/synthetic-disc';
import { createRing, renderQuantum, ringViews } from './audio/ring';
import { runBdjWorker } from './bdj/bdj-worker';
import { ZipArchive } from './bdj/jvm/zip';
import { BdjEvent, type ClassLibrarySource } from './bdj/runtime';
import type { WorkerLike } from './bdj/session';
import type { FromBdj, ToBdj } from './bdj/worker-protocol';
import { CodingType } from './bdmv/stream-types';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import type { VideoCodecApi, VideoDecoderLike } from './decode/video-decoder';
import { Player } from './player';
import type { EngineEvent, PlaybackState } from './protocol';

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

const file = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const CLASSES: ClassLibrarySource = {
  rt: file('../bdj-classlib/rt-bdj.jar'),
  libbluray: file('../bdj-classlib/libbluray-j2se.jar'),
  libblurayAwt: file('../bdj-classlib/libbluray-awt-j2se.jar'),
};
const STEP_MS = 640 / 48;
const START = 1;
/** UO mask table: time search, skip to next / previous point (byte 0) and pause on (byte 1). */
const PLAYBACK_MASKED = [0x1c, 0x80, 0, 0, 0, 0, 0, 0];

/** disc-bdj's index, BD-J objects, jar and certificates over synthetic clips and playlists. */
function bdjDisc(spec: Partial<SyntheticDiscSpec> = {}): Map<string, Uint8Array<ArrayBuffer>> {
  const files = buildSyntheticDisc({
    clips: [
      syntheticClip('00000', 4, { audioStreams: [lpcmStream(0x1100, 4, { lang: 'eng' }), lpcmStream(0x1101, 4, { lang: 'fra' })] }),
      syntheticClip('00001', 4, { audio: CodingType.LPCM }),
    ],
    playlists: [
      { id: '00000', clipIds: ['00000'], chapterEverySeconds: 1, uoMask: PLAYBACK_MASKED },
      { id: '00001', clipIds: ['00001'], chapterEverySeconds: 1 },
    ],
    ...spec,
  });
  const fixture = fixtureDiscFiles('disc-bdj');
  for (const [path, bytes] of fixture) {
    if (path.startsWith('BDMV/BDJO/') || path.startsWith('BDMV/JAR/') || path.startsWith('CERTIFICATE/')) files.set(path, bytes);
    if (path === 'BDMV/index.bdmv' && !spec.index) files.set(path, bytes);
  }
  return files;
}

interface Harness {
  readonly player: Player;
  readonly events: EngineEvent[];
  /** Everything the engine sent to the BD-J worker. */
  readonly sent: ToBdj[];
  readonly terminated: () => boolean;
  /** Delivers a message to the engine as if the BD-J worker had sent it. */
  inject(m: FromBdj): void;
  play(ms: number): Promise<void>;
}

const players: Player[] = [];
afterEach(async () => {
  for (const p of players.splice(0)) await p.handle({ type: 'close' });
});

async function harness(files: Map<string, Uint8Array<ArrayBuffer>>, classes: ClassLibrarySource = CLASSES): Promise<Harness> {
  const events: EngineEvent[] = [];
  const sent: ToBdj[] = [];
  let terminated = false;
  let toEngine: MessagePort | null = null;
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeApi,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
    createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }),
    setTimer: () => () => undefined,
    createBdjWorker: () => {
      const { port1, port2 } = new MessageChannel();
      runBdjWorker(port2 as unknown as Parameters<typeof runBdjWorker>[0]);
      toEngine = port2;
      const worker: WorkerLike = {
        postMessage: (m: ToBdj) => {
          sent.push(m);
          port1.postMessage(m);
        },
        set onmessage(fn: ((e: MessageEvent<FromBdj>) => void) | null) {
          port1.onmessage = fn as ((e: MessageEvent) => void) | null;
        },
        get onmessage() {
          return port1.onmessage as ((e: MessageEvent<FromBdj>) => void) | null;
        },
        terminate: () => {
          terminated = true;
          port1.close();
          port2.close();
        },
      };
      return worker;
    },
    loadClassLibrary: async () => classes,
  });
  players.push(player);
  const ring = createRing(48_000, 2);
  const views = ringViews(ring);
  await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  await player.handle({ type: 'open', entries: discEntries(files) });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    player,
    events,
    sent,
    terminated: () => terminated,
    inject: (m) => toEngine!.postMessage(m),
    async play(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        clock.ms += STEP_MS;
        for (let q = 0; q < 5; q++) renderQuantum(views, left, right);
        player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

const lastState = (h: Harness): PlaybackState | undefined => h.events.flatMap((e) => (e.type === 'state' ? [e.state] : [])).at(-1);
const notices = (h: Harness): string[] => h.events.flatMap((e) => (e.type === 'notice' ? [e.code] : []));
const playlistsPlayed = (h: Harness): string[] => h.events.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : []));
const bdjEvents = (h: Harness, ev: number): number[] => h.sent.flatMap((m) => (m.type === 'event' && m.ev === ev ? [m.param] : []));

async function until(h: Harness, cond: () => boolean, timeout = 60_000): Promise<void> {
  await vi.waitFor(
    async () => {
      await h.play(50);
      expect(cond()).toBe(true);
    },
    { timeout, interval: 1 },
  );
}

/** Opens the disc and waits until Java's first playlist plays. */
async function playing(files = bdjDisc()): Promise<Harness> {
  const h = await harness(files);
  await until(h, () => lastState(h) === 'playing' && playlistsPlayed(h).length > 0);
  return h;
}

describe('Player with BD-J titles (in-process BD-J worker)', () => {
  it('runs First Play: Java plays playlist 00000 with no picker and a menu-hidden notice', async () => {
    const h = await playing();
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'titles', bdjSupported: true }));
    expect(h.events).toContainEqual({ type: 'bdjActive', active: true });
    expect(h.events).toContainEqual({
      type: 'notice',
      code: 'bdj-menu-hidden',
      message: "This disc's menu isn't shown yet. The disc is playing on its own; choose a playlist to take over.",
    });
    expect(notices(h)).not.toContain('bdj');
    expect(playlistsPlayed(h)).toEqual(['00000']);
    expect(h.sent.filter((m) => m.type === 'start')).toEqual([{ type: 'start', title: 0xffff }]);
    // the disc's playlist masks pause and seeks, but under a BD-J title the UI is told only of menu call and title search
    expect(h.events.filter((e) => e.type === 'uoMask').every((e) => e.type === 'uoMask' && e.masked.length === 0)).toBe(true);
  }, 90_000);

  it('never refuses pause or play under a BD-J title, and Java hears RATE', async () => {
    const h = await playing();
    await h.player.handle({ type: 'pause' });
    expect(lastState(h)).toBe('paused');
    await h.player.handle({ type: 'play' });
    await until(h, () => lastState(h) === 'playing');
    expect(notices(h)).not.toContain('uo-masked');
    await until(h, () => bdjEvents(h, BdjEvent.RATE).length >= 2);
    expect(bdjEvents(h, BdjEvent.RATE)).toEqual([0, 90_000]);
  }, 90_000);

  it("leaves playback alone when Java starts a playlist that already plays", async () => {
    const h = await playing();
    const before = h.events.length;
    h.inject({ type: 'call', id: 9001, name: 'selectRate', args: [1, START] });
    h.inject({ type: 'call', id: 9002, name: 'selectRate', args: [1, START] });
    await until(h, () => h.sent.some((m) => m.type === 'reply' && m.id === 9002));
    await h.play(300);
    expect(h.events.slice(before).filter((e) => e.type === 'state' || e.type === 'chapters' || e.type === 'playlistCleared')).toEqual([]);
  }, 90_000);

  it('never refuses a seek or chapter skip under a BD-J title, and Java hears SEEK', async () => {
    const h = await playing();
    await h.player.handle({ type: 'seek', timeUs: 1_200_000 });
    await h.player.handle({ type: 'nextChapter' });
    expect(notices(h)).not.toContain('uo-masked');
    await until(h, () => bdjEvents(h, BdjEvent.SEEK).length >= 2);
    expect(bdjEvents(h, BdjEvent.SEEK)).toEqual([1.2 * 45_000, 2 * 45_000]);
  }, 90_000);

  it("refuses a menu call masked by Java's UO mask, with uo-masked and UO_MASKED to Java", async () => {
    const h = await playing();
    h.inject({ type: 'call', id: 9001, name: 'setUOMask', args: [true, false] });
    await until(h, () => h.events.some((e) => e.type === 'uoMask' && e.masked.includes('menuCall')));
    const starts = h.sent.filter((m) => m.type === 'start').length;
    await h.player.handle({ type: 'menuCall' });
    expect(notices(h)).toContain('uo-masked');
    await until(h, () => bdjEvents(h, BdjEvent.UO_MASKED).length > 0);
    expect(bdjEvents(h, BdjEvent.UO_MASKED)).toEqual([0]); // UO_MASK_MENU_CALL_INDEX
    expect(h.sent.filter((m) => m.type === 'start')).toHaveLength(starts);
  }, 90_000);

  it('starts the top menu title on an unmasked menu call', async () => {
    const h = await playing();
    await h.player.handle({ type: 'menuCall' });
    await until(h, () => h.sent.some((m) => m.type === 'start' && m.title === 0));
    expect(notices(h)).not.toContain('uo-masked');
  }, 90_000);

  it('a playlist chosen in the picker stops BD-J, and no later Java call reaches the player', async () => {
    const h = await playing();
    h.inject({ type: 'call', id: 9001, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    await new Promise((r) => setTimeout(r, 0)); // the call reaches the host and starts opening
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    expect(h.terminated()).toBe(true);
    expect(h.events).toContainEqual({ type: 'bdjActive', active: false });
    h.inject({ type: 'call', id: 9002, name: 'selectRate', args: [0, START] });
    h.inject({ type: 'call', id: 9003, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    await until(h, () => lastState(h) === 'playing');
    await h.play(500);
    expect(playlistsPlayed(h).at(-1)).toBe('00001');
    expect(lastState(h)).toBe('playing');
    expect(h.sent.some((m) => m.type === 'reply' && m.id >= 9001)).toBe(false);
  }, 90_000);

  it('a playlist chosen in the picker also stops BD-J while it is still booting', async () => {
    const h = await harness(bdjDisc());
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    expect(h.terminated()).toBe(true);
    await until(h, () => lastState(h) === 'playing');
    await h.play(1000);
    expect(playlistsPlayed(h)).toEqual(['00001']);
    expect(h.sent.some((m) => m.type === 'start')).toBe(false);
  }, 90_000);

  it('falls back to the picker with bdj-failed when BD-J cannot boot', async () => {
    const z = ZipArchive.open(CLASSES.libbluray);
    const entries = z.names.filter((n) => n !== 'org/videolan/Libbluray.class').map((n) => [n, z.read(n)!] as const);
    const h = await harness(bdjDisc(), { ...CLASSES, libbluray: storedZip(entries) });
    await until(h, () => notices(h).includes('bdj-failed'));
    const failed = h.events.find((e) => e.type === 'notice' && e.code === 'bdj-failed');
    expect(failed).toMatchObject({ message: expect.stringMatching(/^BD-J couldn't start this disc \(class-not-found: .*org\/videolan\/Libbluray.*\)\. Choose a playlist to play\.$/) });
    expect(h.events).toContainEqual({ type: 'bdjActive', active: false });
    expect(h.terminated()).toBe(true);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await until(h, () => lastState(h) === 'playing');
  }, 90_000);

  it("follows Java's PSR1 write with the audio track", async () => {
    const h = await playing();
    expect(h.events.filter((e) => e.type === 'tracks').at(-1)).toMatchObject({ selectedAudio: 1 });
    h.inject({ type: 'call', id: 9001, name: 'writeReg', args: [1, 1, 2, -1] });
    await until(h, () => h.events.filter((e) => e.type === 'tracks').at(-1)?.type === 'tracks' && (h.events.filter((e) => e.type === 'tracks').at(-1) as { selectedAudio: number }).selectedAudio === 2);
    expect(bdjEvents(h, BdjEvent.AUDIO_STREAM)).toContain(2);
  }, 90_000);

  it("hands an HDMV program's BD-J title to BD-J, and a BD-J selectTitle of an HDMV title back to the navigator", async () => {
    const movieObjects = buildMovieObjects([{ cmds: [asm.jumpTitle(imm(1))] }, { cmds: [asm.playPl(imm(1))] }]);
    const files = bdjDisc({
      movieObjects,
      index: { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'bdj', name: '00001' }, { kind: 'hdmv', movieObjectId: 1 }] },
    });
    const h = await playing(files);
    expect(playlistsPlayed(h)).toEqual(['00000']); // TitleXlet's playlist
    expect(h.sent.filter((m) => m.type === 'start')).toEqual([{ type: 'start', title: 1 }]);
    h.inject({ type: 'call', id: 9001, name: 'selectTitle', args: [2] });
    await until(h, () => playlistsPlayed(h).at(-1) === '00001' && lastState(h) === 'playing');
    expect(h.terminated()).toBe(true);
    expect(h.events.filter((e) => e.type === 'bdjActive').at(-1)).toEqual({ type: 'bdjActive', active: false });
  }, 90_000);
});
