import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeVideoCodecApi } from '../../tests/helpers/fake-video-decoder';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { VirtualClock, storedZip } from '../../tests/helpers/jvm-asm';
import { asm, buildMovieObjects, imm } from '../../tests/helpers/hdmv-builders';
import { buildSyntheticDisc, discEntries, lpcmStream, syntheticClip, type SyntheticDiscSpec } from '../../tests/helpers/synthetic-disc';
import { createRing, renderQuantum, ringViews } from './audio/ring';
import { runBdjWorker } from './bdj/bdj-worker';
import { ZipArchive } from './bdj/jvm/zip';
import { BdjEvent, type ClassLibrarySource } from './bdj/runtime';
import type { WorkerLike } from './bdj/session';
import type { FromBdj, ToBdj } from './bdj/worker-protocol';
import { SharedRegisterView } from './bdj/shared-registers';
import type { PlayerSettings } from './disc/player-settings';
import { CodingType } from './bdmv/stream-types';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import { Player } from './player';
import type { CompositorLike } from './render/compositor';
import { GraphicsPlaneReader, GraphicsPlaneWriter, updateGraphic } from './bdj/graphics-plane';
import type { EngineEvent, PlaybackState, Telemetry } from './protocol';

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

interface HarnessOptions {
  readonly classes?: ClassLibrarySource;
  /** A worker the test drives by hand instead of the in-process one. */
  readonly worker?: WorkerLike;
  readonly setTimer?: (ms: number, fn: () => void) => () => void;
  readonly playerSettings?: PlayerSettings;
  readonly compositor?: CompositorLike;
}

async function harness(files: Map<string, Uint8Array<ArrayBuffer>>, opts: HarnessOptions = {}): Promise<Harness> {
  const classes = opts.classes ?? CLASSES;
  const events: EngineEvent[] = [];
  const sent: ToBdj[] = [];
  let terminated = false;
  let toEngine: MessagePort | null = null;
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeVideoCodecApi,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
    createCompositor: () => opts.compositor ?? { resize: () => undefined, drawVideo: () => undefined },
    setTimer: opts.setTimer ?? (() => () => undefined),
    createBdjWorker: () => {
      if (opts.worker) return opts.worker;
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
    ...(opts.playerSettings ? { playerSettings: opts.playerSettings } : {}),
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

/** A BD-J worker the test drives by hand. */
function handWorker(): { readonly worker: WorkerLike; readonly sent: ToBdj[]; emit(m: FromBdj): void; readonly terminated: () => boolean } {
  const sent: ToBdj[] = [];
  let terminated = false;
  const worker: WorkerLike = { postMessage: (m) => void sent.push(m), onmessage: null, terminate: () => void (terminated = true) };
  return { worker, sent, emit: (m) => worker.onmessage?.({ data: m } as MessageEvent<FromBdj>), terminated: () => terminated };
}

const lastState = (h: Harness): PlaybackState | undefined => h.events.flatMap((e) => (e.type === 'state' ? [e.state] : [])).at(-1);
const notices = (h: Harness): string[] => h.events.flatMap((e) => (e.type === 'notice' ? [e.code] : []));
const playlistsPlayed = (h: Harness): string[] => h.events.flatMap((e) => (e.type === 'chapters' ? [e.playlistId] : []));
const lastTelemetry = (h: Harness): Telemetry | undefined => h.events.flatMap((e) => (e.type === 'telemetry' ? [e.telemetry] : [])).at(-1);
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

  it('reports start-up times since the open in telemetry: boot, Java\'s first playlist, its first presented frame (spec §4.7)', async () => {
    const h = await playing();
    await h.play(600); // a telemetry interval
    const bdj = lastTelemetry(h)?.bdj;
    expect(bdj).toBeTruthy();
    const { bootMs, firstPlaylistMs, firstFrameMs } = bdj!;
    expect(bootMs).toBeGreaterThanOrEqual(0);
    expect(firstPlaylistMs).toBeGreaterThanOrEqual(bootMs!);
    expect(firstFrameMs).toBeGreaterThan(firstPlaylistMs!);
    // later playlists and frames do not move them
    await h.play(2000);
    expect(lastTelemetry(h)?.bdj).toEqual(bdj);
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

  it('says BD-J is active before the player goes idle, so the picker never flashes on First Play', async () => {
    const h = await harness(bdjDisc(), { worker: handWorker().worker });
    const types = h.events.map((e) => (e.type === 'state' ? `state:${e.state}` : e.type));
    const titles = types.indexOf('titles');
    expect(types.indexOf('bdjActive', titles)).toBeLessThan(types.indexOf('state:idle', titles));
  });

  it("boots a BD-J First Play's worker while the disc opens (spec §4.7), once, and the title starts once it has booted", async () => {
    const order: string[] = [];
    const w = handWorker();
    const recording: WorkerLike = {
      postMessage: (m) => {
        order.push(`post:${m.type}`);
        w.worker.postMessage(m);
      },
      get onmessage() {
        return w.worker.onmessage;
      },
      set onmessage(fn) {
        w.worker.onmessage = fn;
      },
      terminate: () => w.worker.terminate(),
    };
    const player = new Player({
      emit: (e) => void order.push(`emit:${e.type}`),
      videoCodecApi: fakeVideoCodecApi,
      nowMs: () => 1000,
      requestFrame: () => undefined,
      createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
      createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }),
      setTimer: () => () => undefined,
      createBdjWorker: () => recording,
      loadClassLibrary: async () => CLASSES,
    });
    players.push(player);
    await player.handle({ type: 'open', entries: discEntries(bdjDisc()) });
    await vi.waitFor(() => expect(order).toContain('post:boot'));
    expect(order.filter((o) => o === 'post:boot')).toHaveLength(1);
    expect(order.indexOf('post:boot')).toBeLessThan(order.indexOf('emit:titles'));
    expect(w.sent.some((m) => m.type === 'start')).toBe(false);
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.filter((m) => m.type === 'start')).toEqual([{ type: 'start', title: 0xffff }]));
  });

  it("writes the application's player settings to the registers Java reads (bd_set_player_setting_str)", async () => {
    const w = handWorker();
    await harness(bdjDisc(), { worker: w.worker, playerSettings: { audioLanguage: 'jpn', pgLanguage: 'eng', menuLanguage: 'fra', country: 'jp' } });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    const boot = w.sent.find((m) => m.type === 'boot')!;
    const regs = new SharedRegisterView(boot.type === 'boot' ? boot.registers : new SharedArrayBuffer(0));
    expect([16, 17, 18, 19].map((i) => regs.psrRead(i))).toEqual([0x6a706e, 0x656e67, 0x667261, 0x6a70]);
  });

  it('applies the player settings when an HDMV program hands over to a BD-J title, before the worker boots (R9)', async () => {
    const w = handWorker();
    const movieObjects = buildMovieObjects([{ cmds: [asm.jumpTitle(imm(1))] }]);
    const files = bdjDisc({ movieObjects, index: { firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 0 }, titles: [{ kind: 'bdj', name: '00001' }] } });
    await harness(files, { worker: w.worker, playerSettings: { audioLanguage: 'jpn', pgLanguage: 'eng', menuLanguage: 'fra', country: 'jp' } });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    const boot = w.sent.find((m) => m.type === 'boot')!;
    const regs = new SharedRegisterView(boot.type === 'boot' ? boot.registers : new SharedArrayBuffer(0));
    expect([16, 17, 18, 19].map((i) => regs.psrRead(i))).toEqual([0x6a706e, 0x656e67, 0x667261, 0x6a70]);
  });

  it('falls back with a timeout bdj-failed 20,000 ms after a boot that never completes', async () => {
    const clock = new VirtualClock();
    const w = handWorker();
    const h = await harness(bdjDisc(), { worker: w.worker, setTimer: clock.setTimer });
    await vi.waitFor(() => expect(w.sent.map((m) => m.type)).toEqual(['boot']));
    clock.advance(19_999);
    expect(notices(h)).not.toContain('bdj-failed');
    clock.advance(1);
    expect(h.events.find((e) => e.type === 'notice' && e.code === 'bdj-failed')).toMatchObject({
      message: "BD-J couldn't start this disc (timeout: no playlist was selected within 20 s). Choose a playlist to play.",
    });
    expect(h.events.filter((e) => e.type === 'bdjActive').at(-1)).toEqual({ type: 'bdjActive', active: false });
    expect(w.terminated()).toBe(true);
  });

  it('a playlist Java asked for that is still loading when BD-J fails does not open behind the picker', async () => {
    const w = handWorker();
    const h = await harness(bdjDisc(), { worker: w.worker });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    expect(lastState(h)).toBe('loading');
    w.emit({ type: 'failed', code: 'internal', message: 'boom' });
    await h.play(500);
    expect(playlistsPlayed(h)).toEqual([]);
    expect(lastState(h)).toBe('idle');
    expect(notices(h)).toContain('bdj-failed');
  });

  /** A hand-driven BD-J worker that has booted and started its title. */
  async function startedHand(): Promise<{ readonly h: Harness; readonly w: ReturnType<typeof handWorker> }> {
    const w = handWorker();
    const h = await harness(bdjDisc(), { worker: w.worker });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    return { h, w };
  }

  /** A compositor that records its calls by name; drawBdj also notes the plane's buffer and copies it, as the real one does. */
  function recordingCompositor(): { readonly compositor: CompositorLike; readonly calls: string[]; readonly planes: SharedArrayBuffer[] } {
    const calls: string[] = [];
    const planes: SharedArrayBuffer[] = [];
    const image = { data: new Uint8ClampedArray(1920 * 1080 * 4), width: 1920, height: 1080 } as ImageData;
    const compositor: CompositorLike = {
      resize: () => void calls.push('resize'),
      drawVideo: () => void calls.push('drawVideo'),
      drawIg: () => void calls.push('drawIg'),
      drawBdj: (plane) => {
        calls.push('drawBdj');
        planes.push(plane.buffer);
        plane.copyDirtyInto(image);
      },
      clearBdj: () => void calls.push('clearBdj'),
    };
    return { compositor, calls, planes };
  }

  /** A booted hand-driven BD-J title whose Java has drawn a menu into the plane, shown by a recording compositor. */
  async function menuShown(): Promise<{ h: Harness; w: ReturnType<typeof handWorker>; rec: ReturnType<typeof recordingCompositor>; writer: GraphicsPlaneWriter }> {
    const w = handWorker();
    const rec = recordingCompositor();
    const h = await harness(bdjDisc(), { worker: w.worker, compositor: rec.compositor });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'boot')).toBe(true));
    const boot = w.sent.find((m) => m.type === 'boot')!;
    if (boot.type !== 'boot') throw new Error('no boot');
    w.emit({ type: 'booted', bootMs: 1 });
    await vi.waitFor(() => expect(w.sent.some((m) => m.type === 'start')).toBe(true));
    const writer = new GraphicsPlaneWriter(boot.plane);
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-1), 100, 100, 299, 149);
    await h.play(50);
    expect(rec.planes.at(-1)).toBe(boot.plane);
    expect(new GraphicsPlaneReader(boot.plane).visible()).toBe(true);
    return { h, w, rec, writer };
  }

  it("draws Java's plane on its flush, with no playlist playing, and not again until it changes", async () => {
    const { h, rec, writer } = await menuShown();
    const at = rec.calls.length;
    await h.play(50);
    // a visible plane is drawn whenever the picture is; with no playlist nothing changed, so nothing is drawn
    expect(rec.calls.slice(at)).toEqual([]);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080), 100, 100, 299, 149); // the menu taken down
    await h.play(20);
    expect(rec.calls.slice(at)).toEqual(['drawVideo', 'drawBdj']);
  });

  it('repaints with the plane drawn last when the window is resized (Review Focus 1)', async () => {
    const { h, rec } = await menuShown();
    const at = rec.calls.length;
    await h.player.handle({ type: 'resize', width: 390, height: 844 });
    expect(rec.calls.slice(at)).toEqual(['resize', 'drawVideo', 'drawBdj']);
  });

  /** After `leave`, the plane is cleared at once (a repaint without it) and never drawn again (Review Focus 2). */
  async function clearedBy(leave: (h: Harness, w: ReturnType<typeof handWorker>) => Promise<void>): Promise<void> {
    const { h, w, rec, writer } = await menuShown();
    const at = rec.calls.length;
    await leave(h, w);
    const after = rec.calls.slice(at);
    expect(after.slice(0, 2)).toEqual(['clearBdj', 'drawVideo']);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-1), 0, 0, 9, 9); // a worker still drawing as it dies
    await h.play(500);
    expect(rec.calls.slice(at)).not.toContain('drawBdj');
    expect(w.terminated()).toBe(true);
  }

  it('clears the plane at once when the user picks a playlist in the picker', async () => {
    await clearedBy((h) => h.player.handle({ type: 'playPlaylist', playlistId: '00001' }));
  });

  it('clears the plane at once when the disc closes', async () => {
    await clearedBy((h) => h.player.handle({ type: 'close' }));
  });

  it('clears the plane at once when BD-J fails', async () => {
    await clearedBy(async (h, w) => {
      w.emit({ type: 'failed', code: 'internal', message: 'boom' });
      expect(notices(h)).toContain('bdj-failed');
    });
  });

  it('a playlist Java asked for that is still loading when the disc closes never opens afterwards', async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    expect(lastState(h)).toBe('loading');
    await h.player.handle({ type: 'close' });
    const at = h.events.length;
    await h.play(500);
    const after = h.events.slice(at).map((e) => e.type);
    expect(after).not.toContain('chapters');
    expect(after).not.toContain('tracks');
    expect(after).not.toContain('state');
    expect(lastState(h)).toBe('idle');
  });

  it('a playlist Java asked for that is still loading when another disc opens never plays on the new disc', async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    expect(lastState(h)).toBe('loading');
    const other = buildSyntheticDisc({ clips: [syntheticClip('00009', 4, { audio: CodingType.LPCM })], playlists: [{ id: '00009', clipIds: ['00009'] }] });
    const at = h.events.length;
    await h.player.handle({ type: 'open', entries: discEntries(other) });
    await h.play(500);
    expect(h.events.slice(at).some((e) => e.type === 'chapters' || e.type === 'tracks')).toBe(false);
    expect(lastState(h)).toBe('idle');
  });

  it('a second Java playlist still loading when BD-J fails during playback never starts', async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    await until(h, () => playlistsPlayed(h).length === 1 && lastState(h) === 'paused');
    w.emit({ type: 'call', id: 2, name: 'selectPlaylist', args: [1, -1, -1, '-1'] });
    w.emit({ type: 'failed', code: 'internal', message: 'boom' });
    await h.play(500);
    expect(playlistsPlayed(h)).toEqual(['00000']);
    expect(notices(h)).toContain('bdj-failed');
  });

  it("plays a playlist once loaded when Java's START came while it was still loading", async () => {
    const { h, w } = await startedHand();
    w.emit({ type: 'call', id: 1, name: 'selectPlaylist', args: [0, -1, -1, '-1'] });
    expect(lastState(h)).toBe('loading');
    w.emit({ type: 'call', id: 2, name: 'selectRate', args: [1, START] });
    await until(h, () => lastState(h) === 'playing' && playlistsPlayed(h).length === 1, 10_000);
  }, 30_000);

  it('falls back to the picker with bdj-failed when BD-J cannot boot', async () => {
    const z = ZipArchive.open(CLASSES.libbluray);
    const entries = z.names.filter((n) => n !== 'org/videolan/Libbluray.class').map((n) => [n, z.read(n)!] as const);
    const h = await harness(bdjDisc(), { classes: { ...CLASSES, libbluray: storedZip(entries) } });
    await until(h, () => notices(h).includes('bdj-failed'));
    const failed = h.events.find((e) => e.type === 'notice' && e.code === 'bdj-failed');
    expect(failed).toMatchObject({ message: expect.stringMatching(/^BD-J couldn't start this disc \(class-not-found: .*org\/videolan\/Libbluray.*\)\. Choose a playlist to play\.$/) });
    expect(h.events).toContainEqual({ type: 'bdjActive', active: false });
    expect(h.terminated()).toBe(true);
    await h.player.handle({ type: 'playPlaylist', playlistId: '00001' });
    await until(h, () => lastState(h) === 'playing');
    await h.play(600);
    // a playlist the user chose is not Java's first playlist
    expect(lastTelemetry(h)?.bdj).toEqual({ bootMs: null, firstPlaylistMs: null, firstFrameMs: null });
  }, 90_000);

  it('falls back to the picker with bdj-failed on an unreadable libbluray jar (the browser\'s ?bdjfail=1 hook)', async () => {
    const h = await harness(bdjDisc(), { classes: { ...CLASSES, libbluray: new Uint8Array(0) } });
    await until(h, () => notices(h).includes('bdj-failed'));
    expect(h.events).toContainEqual({ type: 'bdjActive', active: false });
    expect(lastState(h)).toBe('idle');
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

  it('disc-bdj-mixed: First Play (BD-J) selects HDMV title 1, whose playlist ends in JumpTitle 2 (BD-J), which plays 00001', async () => {
    const h = await harness(fixtureDiscFiles('disc-bdj-mixed'));
    await until(h, () => playlistsPlayed(h).at(-1) === '00001' && lastState(h) === 'playing');
    expect(playlistsPlayed(h)).toEqual(['00000', '00001']);
    expect(h.sent.filter((m) => m.type === 'start')).toEqual([
      { type: 'start', title: 0xffff },
      { type: 'start', title: 2 },
    ]);
    expect(h.events.flatMap((e) => (e.type === 'bdjActive' ? [e.active] : []))).toEqual([true, false, true]);
    expect(notices(h)).not.toContain('bdj-failed');
  }, 90_000);
});
