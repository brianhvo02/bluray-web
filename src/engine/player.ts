import { AudioWriter } from './audio/audio-writer';
import { OUTPUT_SAMPLE_RATE, RingWriter, ringViews } from './audio/ring';
import { type PlayItem } from './bdmv/mpls-parser';
import { codingName, isVideoCoding } from './bdmv/stream-types';
import { MasterClock } from './clock/master-clock';
import { Decimator } from './decode/decimator';
import { UnsupportedCodecError, type DecoderError } from './decode/decoder';
import { type AudioDecodeResult, type AudioDecoder, type AudioDecoderFactory } from './decode/audio-decoder';
import { WebCodecsVideoDecoder, hasSps, isSupportedVideoCoding, type VideoCodecApi, type VideoUnit } from './decode/video-decoder';
import { M2tsReader } from './demux/m2ts-reader';
import { DiscError } from './disc/byte-source';
import { applyDiscProfile } from './disc/disc-profile';
import { FileSource } from './disc/file-source';
import { checkStreamReadable, loadClips, openDisc, playlistPath, readBdid, streamPath, type DiscModel } from './disc/open-disc';
import { normalizeDiscPaths } from './disc/paths';
import { BdVk } from './graphics/graphics-controller';
import { PSR, RegisterFile, type PsrEvent } from './hdmv/registers';
import type { UoOp } from './hdmv/uo-mask';
import { Navigator, type IgUnit, type NavigatorEvent, type PlaybackPort, type PlayAt } from './nav/navigator';
import { lookupSpn } from './nav/packets';
import { PgStreamControl } from './nav/subtitles';
import { Timeline, type Chapter } from './nav/timeline';
import { PlaybackPipeline, type PipelineAudioUnit, type PipelineUnit } from './playback/pipeline';
import { PLAYABLE_AUDIO, audioEntryFor, chooseStreams } from './playback/stream-selection';
import { audioTracks } from './playback/tracks';
import type { FontFile } from './ass/font-tables';
import { AssFonts, type FontLoader } from './ass/fonts';
import type { GlyphMeasurer } from './ass/measure';
import { looksLikeAss, parseAss } from './ass/parse';
import { AssRenderer } from './ass/renderer';
import type { Mat3 } from './ass/transform';
import type { AssTrack } from './ass/types';
import type { AudioTrack, EngineCommand, EngineEvent, FileData, MenuKey, NoticeCode, PlaybackState, ShaderSetData, SubtitleChoice } from './protocol';
import type { CompositorLike, TextRendererLike } from './render/compositor';
import { ShaderStage } from './shaders/stage';
import { UNAVAILABLE, type ShaderBackend } from './shaders/webgl-backend';
import { decodeText, parseSrt } from './subs/srt';
import { TextSubtitleRenderer, type TextRenderOptions } from './subs/text-renderer';
import { episodeStarts, sortByName, TextSet, TextSetRenderer, type SetFile } from './subs/text-set';
import { VideoPresenter } from './render/video-presenter';
import { ParseError } from './util/byte-reader';
import { pts90ToUs, ticks45ToUs } from './util/time';

const UO_MASKED_MESSAGE = "The disc doesn't allow this here.";
const NO_SUBTITLES_MESSAGE = 'this file has no subtitles we can read';
const SOME_SUBTITLES_MESSAGE = 'Some lines of this file could not be read';
const PLACE_FILES_MESSAGE = "Place each subtitle file at its episode's start in the subtitle menu";
const NO_SHADER_BACKEND_MESSAGE = 'Shaders are unavailable here';
const MIN_TEXT_SCALE = 0.5;
const MAX_TEXT_SCALE = 2;
/** The operation each menu key is (pop-up depends on whether the pop-up is shown). */
const MENU_KEY_UO: Partial<Record<MenuKey, UoOp>> = {
  up: 'moveUp', down: 'moveDown', left: 'moveLeft', right: 'moveRight', ok: 'activate', topMenu: 'menuCall',
};
const MENU_KEY_VK: Readonly<Record<Exclude<MenuKey, 'topMenu'>, number>> = {
  up: BdVk.UP, down: BdVk.DOWN, left: BdVk.LEFT, right: BdVk.RIGHT, ok: BdVk.ENTER, popup: BdVk.POPUP,
  '0': BdVk.D0, '1': BdVk.D1, '2': BdVk.D2, '3': BdVk.D3, '4': BdVk.D4, '5': BdVk.D5, '6': BdVk.D6, '7': BdVk.D7, '8': BdVk.D8, '9': BdVk.D9,
};

export interface PlayerDeps {
  emit(event: EngineEvent): void;
  readonly videoCodecApi: VideoCodecApi;
  nowMs(): number;
  requestFrame(callback: () => void): void;
  createCompositor(canvas: OffscreenCanvas): CompositorLike;
  readonly createAudioDecoder: AudioDecoderFactory;
  /** What ASS subtitles need from the browser (fonts, measuring, canvases); created once, when the first ASS file loads. */
  readonly createAssDeps?: () => Promise<AssDeps>;
  /** The GPU backend for video shaders, or why there is none; created once, when the first set is chosen. */
  readonly createShaderBackend?: (events: { lost(): void; restored(): void }) => ShaderBackend | string;
}

export interface AssDeps {
  readonly loader: FontLoader;
  readonly defaultFont: FontFile;
  readonly measurer: GlyphMeasurer;
  readonly createCanvas: (w: number, h: number) => OffscreenCanvas;
  readonly Path2D: typeof Path2D;
  readonly warp?: (target: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, m: Mat3, originX: number, originY: number) => void;
}

/** The user's subtitle set: files in name order, each SRT or ASS, and the fonts its ASS files share. */
interface TextTrack {
  readonly files: readonly SetFile<TextRendererLike>[];
  readonly renderer: TextSetRenderer<TextRendererLike>;
  readonly fonts: AssFonts | null;
  readonly assTracks: readonly AssTrack[];
  /** The playlist placements were last chosen for. */
  placedFor: string | null;
}

/** Decoded frames held for presentation and chunks inside the decoder: kept small (GPU memory, decoder pools). */
const MAX_QUEUED_FRAMES = 8;
const MAX_DECODE_QUEUE = 8;
/**
 * Read-ahead budget for compressed video waiting to enter the decoder. Discs may multiplex video
 * well ahead of its audio (≥ 0.5 s seen on real discs), so reading must be able to run this far
 * ahead in video to reach the audio that is needed now.
 */
const MAX_ENCODED_VIDEO_US = 2_000_000;
const MAX_ENCODED_VIDEO_BYTES = 64 * 1024 * 1024;
const AUDIO_PREBUFFER_US = 200_000;
const TIME_EVENT_INTERVAL_US = 250_000;
const TELEMETRY_INTERVAL_MS = 500;
const HEARTBEAT_TIMEOUT_MS = 500;
const MAX_AUDIO_ERRORS_IN_ROW = 50;
/** Frames up to this far before a seek target are still shown (EP pts are truncated by up to ~5.7 ms). */
const SEEK_TOLERANCE_US = 1_000;
const NEXT_CHAPTER_GUARD_US = 500_000;
const PREV_CHAPTER_RESTART_US = 3_000_000;
/** A still play item is held this close to its end, so the last frame stays on screen. */
const STILL_MARGIN_US = 40_000;
const SCR_PER_MS = 90;
/** libbluray does not preload sub-path clips larger than this (PRELOAD_SIZE_LIMIT). */
const PRELOAD_SIZE_LIMIT = 512 * 1024 * 1024;
const INDEX_ID_NONE = 0xffff;

interface Session {
  readonly playlistId: string;
  readonly timeline: Timeline;
  readonly chapters: readonly Chapter[];
  readonly tracks: readonly AudioTrack[];
  readonly videoCodingType: number;
  readonly decoder: WebCodecsVideoDecoder;
  readonly pipeline: PlaybackPipeline;
  readonly playItems: readonly PlayItem[];
  /** 1-based STN audio stream number; null when the playlist has no playable audio. */
  audioStream: number | null;
  readonly audioDecoders: Map<number, AudioDecoder>;
  readonly audioDecoderLoads: Map<number, Promise<AudioDecoder>>;
  audioErrorsInRow: number;
  /** Coding types whose decoder is unusable this session (not playable, or the load failed); cleared by a seek or switch. */
  readonly failedAudioTypes: Set<number>;
  /** Audio was turned off by too many decode errors; the next seek or switch tries again. */
  audioErrorDisabled: boolean;
  audioActive: boolean;
  decimator: Decimator | null;
  videoState: 'unconfigured' | 'configuring' | 'configured' | 'failed';
  pendingVideo: VideoUnit[];
  dropBeforeUs: number;
  eof: boolean;
  flushed: boolean;
  /** Decoder flush issued at end of input (only after the compressed backlog drains). */
  flushStarted: boolean;
  /** Worklet heartbeat when audio was disabled because the output stalled; null if not stalled. */
  audioStalledBeat: number | null;
  /** A seek that moves playback back onto a recovered output is queued. */
  audioRecoveryQueued: boolean;
}

function isMediaError(err: unknown): boolean {
  return err instanceof DiscError || err instanceof UnsupportedCodecError || err instanceof ParseError;
}

/** Owns one disc and at most one playing playlist. Runs inside the engine worker. */
export class Player {
  private source: FileSource | null = null;
  private disc: DiscModel | null = null;
  private soundsPlayed = 0;
  private session: Session | null = null;
  private state: PlaybackState = 'idle';
  private wantPlaying = false;
  private ring: RingWriter | null = null;
  private audioWriter: AudioWriter | null = null;
  private compositor: CompositorLike | null = null;
  private readonly presenter = new VideoPresenter<VideoFrame>();
  private readonly clock: MasterClock;
  private seekGeneration = 0;
  private renderLoopStarted = false;
  private lastTimeEmitted = Number.NEGATIVE_INFINITY;
  private lastTelemetryMs = Number.NEGATIVE_INFINITY;
  private lastHeartbeat = -1;
  private lastHeartbeatChangeMs = 0;
  private decoderErrors = 0;
  private offsets: number[] = [];
  private audioDecodeErrors = 0;
  private audioCodec: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** HDMV navigation (First Play, titles, menus); null for discs without MovieObject.bdmv, BD-J First Play, or after a raw pick. */
  private navigator: Navigator | null = null;
  private navRegs: RegisterFile | null = null;
  private navItem = 0;
  /** libbluray's next_mark: index of the first play mark after the presentation position, -1 when none is left. */
  private navNextMark = -1;
  /** Seeks the navigator asked for (PLAY_PI / PLAY_PM) that are queued but have not run: marks are not reported meanwhile. */
  private navSeeksPending = 0;
  /** Presentation is frozen (still image): the clock and audio output are stopped. */
  private held = false;
  /** The play item whose end was reported to the navigator; reset on an item change and on every seek. */
  private navEndReported: number | null = null;
  private menuActive = false;
  /** Draw operations of the last repaint of the IG plane. */
  private igDraws = 0;
  private popupAvailable = false;
  /** Bumped by every playlist open and by navigator teardown, so a superseded open stops early. */
  private openGeneration = 0;
  /** PG subtitles of the open disc, on the navigator's registers or, without a navigator, on pgRegs. */
  private pg: PgStreamControl | null = null;
  private pgRegs: RegisterFile | null = null;
  /** The disc ID BD-J's host will need (id.bdmv); not private only until something reads it (noUnusedLocals). */
  protected bdjDiscId: string | null = null;
  private unsubscribePg: (() => void) | null = null;
  /** The PG track list last sent in a 'subtitles' event ('' forces the next one). */
  private sentPgTracks = '';
  /** The user's subtitle set; it belongs to the open disc (kept across playlists, dropped with the disc). */
  private textTrack: TextTrack | null = null;
  private textOn = false;
  private textScale = 1;
  /** Bumped by every subtitle load and by closing the disc: a load that finds it changed is dropped. */
  private textLoadGeneration = 0;
  private assDeps: Promise<AssDeps> | null = null;
  /** A subtitle setting changed: the next paint redraws even when no frame or plane changed. */
  private subtitlesDirty = false;
  /** Video shaders; created with the first set chosen and kept for the page (across discs). */
  private shaderStage: ShaderStage | null = null;
  /** The shader set changed: the next paint redraws the current frame even when nothing else changed. */
  private shadersDirty = false;

  constructor(private readonly deps: PlayerDeps) {
    this.clock = new MasterClock(deps.nowMs);
  }

  /** Commands run strictly one at a time, in arrival order. */
  handle(cmd: EngineCommand): Promise<void> {
    this.queue = this.queue.then(() => this.run(cmd));
    return this.queue;
  }

  private async run(cmd: EngineCommand): Promise<void> {
    try {
      switch (cmd.type) {
        case 'open':
          await this.open(cmd.entries);
          break;
        case 'attachCanvas':
          this.compositor = this.deps.createCompositor(cmd.canvas);
          if (this.shaderStage) this.compositor.setShaderStage?.(this.shaderStage);
          this.startRenderLoop();
          break;
        case 'attachAudio':
          this.ring = new RingWriter(ringViews(cmd.ring));
          this.audioWriter = new AudioWriter(this.ring);
          break;
        case 'resize':
          this.compositor?.resize(cmd.width, cmd.height);
          this.compositor?.drawVideo(this.presenter.current);
          if (this.pg) this.compositor?.drawPg?.(this.pg.plane);
          if (this.textOn && this.textTrack) this.compositor?.drawText?.(this.textTrack.renderer, this.clock.nowUs(), this.textOptions());
          if (this.navigator?.igPlane) this.compositor?.drawIg?.(this.navigator.igPlane);
          break;
        case 'playPlaylist':
          this.stopNavigator();
          await this.playPlaylist(cmd.playlistId);
          break;
        case 'playTitle':
          if (this.refused(cmd.title === 0 ? 'menuCall' : 'titleSearch')) break;
          this.playTitle(cmd.title);
          break;
        case 'menuCall':
          if (this.refused('menuCall')) break;
          this.playTitle(0);
          break;
        case 'menuKey':
          this.menuKey(cmd.key);
          break;
        case 'pointer':
          this.pointer(cmd.kind, cmd.x, cmd.y);
          break;
        case 'play':
          await this.play();
          break;
        case 'pause':
          if (this.refused('pauseOn')) break;
          this.pause();
          break;
        case 'close':
          this.close();
          break;
        case 'setVideoShaders':
          this.setVideoShaders(cmd.set);
          break;
        case 'seek':
          if (this.refused('timeSearch')) break;
          this.notifySeeked(cmd.timeUs);
          // ASS collision memory belongs to what was on screen before the seek
          for (const f of this.textTrack?.files ?? []) if (f.renderer instanceof AssRenderer) f.renderer.reset();
          await this.startAt(cmd.timeUs, this.wantPlaying);
          break;
        case 'selectAudio':
          await this.selectAudio(cmd.index);
          break;
        case 'selectSubtitle':
          this.selectSubtitle(cmd.choice);
          break;
        case 'addTextSubtitles':
          await this.addTextSubtitles(cmd.files, cmd.encoding, cmd.fonts ?? []);
          break;
        case 'addSubtitleFonts':
          await this.addSubtitleFonts(cmd.fonts);
          break;
        case 'removeTextSubtitle':
          this.dropTextTrack();
          this.textOn = false;
          this.subtitlesChanged();
          break;
        case 'setSubtitleStart':
          if (cmd.startUs === null || Number.isFinite(cmd.startUs)) this.textTrack?.renderer.set.setStart(cmd.file, cmd.startUs);
          this.subtitlesChanged();
          break;
        case 'setSubtitleOffset':
          if (Number.isFinite(cmd.ms)) this.textTrack?.renderer.set.setOffset(cmd.file, cmd.ms);
          this.subtitlesChanged();
          break;
        case 'setSubtitleScale':
          if (Number.isFinite(cmd.scale)) this.textScale = Math.max(MIN_TEXT_SCALE, Math.min(MAX_TEXT_SCALE, cmd.scale));
          this.subtitlesChanged();
          break;
        case 'nextChapter':
          if (this.refused('skipToNextPoint')) break;
          await this.skipChapter(1);
          break;
        case 'prevChapter':
          if (this.refused('skipBackToPreviousPoint')) break;
          await this.skipChapter(-1);
          break;
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /** One render tick (requestAnimationFrame in the worker; called directly by tests). */
  tick(): void {
    this.navigator?.tick(this.clock.nowUs());
    const s = this.session;
    if (!s) return;
    this.updatePlayback(s);
    this.syncNavigator(s);
    const now = this.clock.nowUs();
    const frame = this.presenter.select(now);
    if (frame && this.state === 'playing') this.offsets.push(now - frame.timestamp);
    this.pg?.tick(now);
    this.paint(frame, now);
    this.feedDecoder(s); // presenting freed decoded-frame slots
    const last = this.presenter.current;
    if (this.state === 'playing' && !this.held && s.flushed && this.presenter.size === 0 && now >= (last?.timestamp ?? 0) + 100_000) {
      this.wantPlaying = false;
      this.ring?.setPlaying(false);
      this.clock.setRunning(false);
      // With a navigator, its program decides what follows: the next playlist replaces the session
      this.navigator?.playlistEnded();
      if (this.session === s) this.setState('ended');
    }
    if (this.session !== s) return; // the navigator replaced the session
    this.emitTime(Math.min(now, s.timeline.durationUs), false);
    this.maybeEmitTelemetry(s);
  }

  /**
   * Video, then the PG plane, the text subtitles and the IG plane. A change to any of them repaints the video and
   * everything over it (an overlay replaces pixels, it does not blend with what it covered).
   */
  private paint(frame: VideoFrame | null, nowUs: number): void {
    const nav = this.navigator;
    const pg = this.pg?.plane ?? null;
    const ig = nav?.igPlane ?? null;
    const text = this.textOn && this.compositor?.drawText ? this.textTrack : null;
    const textOpts = this.textOptions();
    const pgChanged = pg !== null && pg.dirty() !== null;
    const igChanged = ig !== null && ig.dirty() !== null;
    const textChanged = this.subtitlesDirty || (text !== null && text.renderer.changed(nowUs, textOpts));
    this.subtitlesDirty = false;
    const changed = pgChanged || igChanged || textChanged || this.shadersDirty;
    this.shadersDirty = false;
    if (frame) this.compositor?.drawVideo(frame);
    else if (changed) this.compositor?.drawVideo(this.presenter.current);
    if (!(frame || changed)) return;
    // an empty plane needs no per-frame draw
    if (pg && (pg.hasContent || pgChanged)) {
      if (this.compositor?.drawPg) this.compositor.drawPg(pg);
      else pg.takeDirty();
    }
    if (text) this.compositor?.drawText?.(text.renderer, nowUs, textOpts);
    if (ig && (ig.hasContent || igChanged)) {
      if (this.compositor?.drawIg) this.compositor.drawIg(ig);
      else ig.takeDirty();
    }
    if (igChanged && nav) this.igDraws = nav.takeDrawCount();
  }

  private setVideoShaders(set: ShaderSetData | null): void {
    if (!this.shaderStage) {
      if (!set) {
        this.deps.emit({ type: 'shaderStatus', state: 'off', set: null, error: null });
        return;
      }
      let backend: ShaderBackend | string | undefined;
      try {
        backend = this.deps.createShaderBackend?.({ lost: () => this.shaderStage?.contextLost(), restored: () => this.shaderStage?.contextRestored() });
      } catch {
        backend = UNAVAILABLE; // e.g. OffscreenCanvas or getContext throwing: report unavailable rather than failing playback
      }
      this.shaderStage = new ShaderStage(
        backend ?? NO_SHADER_BACKEND_MESSAGE,
        (status) => this.deps.emit({ type: 'shaderStatus', ...status }),
        () => {
          this.shadersDirty = true;
        },
      );
      this.compositor?.setShaderStage?.(this.shaderStage);
    }
    this.shaderStage.setSet(set);
  }

  private startRenderLoop(): void {
    if (this.renderLoopStarted) return;
    this.renderLoopStarted = true;
    const loop = (): void => {
      try {
        this.tick();
      } catch (err) {
        if (this.state !== 'error') this.fail(err); // report once; the loop keeps running so recovery stays possible
      } finally {
        this.deps.requestFrame(loop);
      }
    };
    this.deps.requestFrame(loop);
  }

  private async open(entries: ReadonlyArray<readonly [string, Blob]>): Promise<void> {
    this.stopNavigator();
    this.teardownSession();
    this.setState('loading');
    const source = new FileSource(normalizeDiscPaths(entries));
    const disc = await openDisc(source);
    this.source = source;
    this.disc = disc;
    this.soundsPlayed = 0;
    this.bdjDiscId = disc.usesBdj ? ((await readBdid(source))?.discId ?? null) : null;
    this.pgRegs = new RegisterFile();
    applyDiscProfile(this.pgRegs, disc.index);
    this.bindPg(this.pgRegs);
    this.resetTextSubtitles();
    this.emitSubtitles();
    this.deps.emit({ type: 'titles', playlists: disc.summaries, usesBdj: disc.usesBdj, warnings: disc.warnings });
    if (disc.movieObjects) this.emitIndexTitles(disc);
    if (disc.sounds) this.deps.emit({ type: 'soundEffects', clips: disc.sounds.clips.map((c) => ({ channels: c.channels, samples: c.samples })) });
    if (disc.usesBdj) this.notice('bdj', 'This disc uses BD-J (Java) menus, which are not supported. Choose a playlist to play.');
    this.setState('idle');
    if (disc.movieObjects && disc.index.firstPlay.kind === 'hdmv') {
      this.navigator = this.createNavigator(disc);
      this.navigator.start();
    }
  }

  private emitIndexTitles(disc: DiscModel): void {
    const titles = disc.index.titles.flatMap((t, i) => (t.object.kind === 'hdmv' || t.object.kind === 'bdj' ? [{ number: i + 1, kind: t.object.kind }] : []));
    const top = disc.index.topMenu;
    const hasTopMenu = top.kind === 'bdj' || (top.kind === 'hdmv' && top.movieObjectId !== INDEX_ID_NONE);
    this.deps.emit({ type: 'indexTitles', titles, hasTopMenu });
  }

  private createNavigator(disc: DiscModel): Navigator {
    const regs = new RegisterFile();
    applyDiscProfile(regs, disc.index);
    regs.onPsrEvent((e) => this.onPsrEvent(e, regs));
    this.navRegs = regs;
    this.bindPg(regs);
    this.menuActive = false;
    this.popupAvailable = false;
    this.igDraws = 0;
    return new Navigator({
      disc,
      regs,
      port: this.navigationPort(),
      emit: (e) => this.onNavigatorEvent(e),
      nowScr: () => this.deps.nowMs() * SCR_PER_MS,
      preloadSubPathIg: (clipId, signal) => this.preloadSubPathIg(clipId, signal),
    });
  }

  /** _preload_m2ts for an IG sub-path: the whole clip is demuxed into the PES units of every IG PID (0x1400 to 0x141f), in stream order. */
  private async preloadSubPathIg(clipId: string, signal: AbortSignal): Promise<IgUnit[]> {
    const source = this.source;
    const path = streamPath(clipId);
    if (!source || !source.exists(path)) throw new DiscError('missing-file', `Missing sub-path clip ${path}`, [path]);
    if (source.size(path) > PRELOAD_SIZE_LIMIT) throw new DiscError('unreadable-stream', `Sub-path clip ${path} is too large to preload`, [path]);
    const reader = new M2tsReader({ source, path, startSpn: 0, pids: new Set(Array.from({ length: 0x20 }, (_, k) => 0x1400 + k)) });
    const cancel = (): void => reader.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const units: IgUnit[] = [];
    try {
      for (let pes = await reader.next(); pes !== null; pes = await reader.next()) {
        for (const p of pes) units.push({ pid: p.pid, data: p.payload, ptsUs: pts90ToUs(p.pts ?? 0), dtsUs: p.dts === undefined ? undefined : pts90ToUs(p.dts) });
      }
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    if (signal.aborted) throw signal.reason;
    return units;
  }

  /** Drops the navigator (and with it the VM and the registers) and releases a hold. */
  private stopNavigator(): void {
    const nav = this.navigator;
    if (!nav) return;
    this.navigator = null;
    this.navRegs = null;
    this.openGeneration++;
    nav.stop();
    if (this.pgRegs) this.bindPg(this.pgRegs);
    this.setHold(false);
    this.updateMenuState(false, false);
    this.deps.emit({ type: 'uoMask', masked: [] });
  }

  /**
   * A title, or the top menu for 0 (a menu call). After a raw playlist pick stopped the program, the navigator is rebuilt
   * and starts the title directly.
   */
  private playTitle(title: number): void {
    const nav = this.navigator;
    if (nav) {
      if (title === 0) nav.menuCall();
      else nav.playTitle(title);
      return;
    }
    const disc = this.disc;
    if (!disc?.movieObjects || disc.index.firstPlay.kind !== 'hdmv') return;
    this.navigator = this.createNavigator(disc);
    if (!this.navigator.startTitle(title)) this.stopNavigator();
  }

  private menuKey(key: MenuKey): void {
    const nav = this.navigator;
    if (!nav) return;
    const op = MENU_KEY_UO[key] ?? (key === 'popup' ? (this.menuActive && this.popupAvailable ? 'popupOff' : 'popupOn') : undefined);
    if (op && this.refused(op)) return;
    if (key === 'topMenu') this.playTitle(0);
    else nav.userInput(MENU_KEY_VK[key]);
  }

  /** A move selects the button under the pointer (bd_mouse_select) and reports it; a click also activates it. */
  private pointer(kind: 'move' | 'click', x: number, y: number): void {
    const nav = this.navigator;
    if (!nav) return;
    const px = Math.max(0, Math.min(0xffff, Math.round(x)));
    const py = Math.max(0, Math.min(0xffff, Math.round(y)));
    nav.mouseSelect(px, py);
    if (kind === 'click') nav.userInput(BdVk.MOUSE_ACTIVATE);
    else this.deps.emit({ type: 'pointerTarget', button: nav.hitTest(px, py) });
  }

  private onNavigatorEvent(e: NavigatorEvent): void {
    switch (e.type) {
      case 'uoMask':
        this.deps.emit({ type: 'uoMask', masked: [...e.mask] });
        break;
      case 'menu':
        this.updateMenuState(e.active, this.popupAvailable);
        break;
      case 'popup':
        this.updateMenuState(this.menuActive, e.available);
        break;
      case 'bdjTitle':
        this.notice('bdj', 'This title uses BD-J (Java), which is not supported. Choose a playlist to play.');
        break;
      case 'error':
        // The picker shows an 'error' event's message (PlayerScreen reads snapshot.error) once the session is gone.
        this.stopNavigator();
        this.teardownSession();
        this.deps.emit({ type: 'error', code: 'internal', message: e.message, paths: [] });
        this.setState('idle');
        break;
      case 'sound':
        this.soundsPlayed++;
        this.deps.emit({ type: 'soundEffect', id: e.id });
        break;
      default:
        break; // 'title' is for the menu UI
    }
  }

  private updateMenuState(active: boolean, popupAvailable: boolean): void {
    if (active === this.menuActive && popupAvailable === this.popupAvailable) return;
    this.menuActive = active;
    this.popupAvailable = popupAvailable;
    this.deps.emit({ type: 'menuActive', active, popupAvailable });
  }

  private navigationPort(): PlaybackPort {
    return {
      playPlaylist: async (id, at) => {
        try {
          return await this.playPlaylist(id, at, true);
        } catch (err) {
          // A clip that cannot be opened or decoded is an invalid playlist to the VM (_open_playlist returns 0)
          if (!isMediaError(err)) throw err;
          this.reportError(err);
          if (!this.session) this.setState('idle');
          return false;
        }
      },
      seekPlayItem: (item) => {
        const s = this.session;
        if (s && item >= 0 && item < s.timeline.items.length) this.enqueueNavSeek(s, s.timeline.itemStartUs(item));
      },
      seekMark: (mark) => {
        const s = this.session;
        if (!s) return;
        try {
          this.enqueueNavSeek(s, s.timeline.markTimeUs(mark));
        } catch (err) {
          if (!(err instanceof RangeError)) throw err;
        }
      },
      stopPlaylist: () => {
        this.openGeneration++; // also cancels an open that is still loading
        this.teardownSession();
        this.setState('idle');
      },
      hold: (on) => this.setHold(on),
      // _update_time_psr_from_stream: the clip time of the presentation position
      currentClipTime45: () => (this.session ? this.session.timeline.locate(this.clock.nowUs()).clipTime45 : undefined),
    };
  }

  /** A seek the navigator asked for: the target is applied once the queued commands ran. */
  private enqueueNavSeek(s: Session, timeUs: number): void {
    this.navSeeksPending++;
    this.enqueue(async () => {
      try {
        if (this.session === s) await this.startAt(timeUs, this.wantPlaying);
      } finally {
        this.navSeeksPending--;
      }
    });
  }

  /** A user seek: libbluray's _seek_internal updates the chapter PSR for the packet the target time maps to. */
  private notifySeeked(targetUs: number): void {
    const s = this.session;
    if (!s || !this.navigator) return;
    const t = Math.min(Math.max(0, targetUs), Math.max(0, s.timeline.durationUs - 1));
    const at = s.timeline.locate(t);
    this.navigator.seeked(at.item.index, at.clipTime45);
  }

  /** Runs `work` after the queued commands, reporting a failure like a command's. */
  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      try {
        await work();
      } catch (err) {
        this.fail(err);
      }
    });
  }

  private setHold(on: boolean): void {
    if (on === this.held) return;
    this.held = on;
    if (on) {
      this.ring?.setPlaying(false);
      this.clock.setRunning(false);
    } else if (this.state === 'playing') {
      const ring = this.session?.audioActive ? this.ring : null;
      if (ring) {
        ring.setPlaying(true);
        this.lastHeartbeat = ring.heartbeat();
        this.lastHeartbeatChangeMs = this.deps.nowMs();
      } else {
        this.clock.setRunning(true);
      }
    }
  }

  /** PSR1 (primary audio stream) selects the audio: the registers are the single source of the selection. */
  private onPsrEvent(e: PsrEvent, regs: RegisterFile): void {
    if (e.type !== 'change' || e.psr !== PSR.PRIMARY_AUDIO_ID || regs !== this.navRegs) return;
    const index = regs.psrRead(PSR.PRIMARY_AUDIO_ID) & 0xfff;
    this.enqueue(() => this.applyAudio(index));
  }

  /** Presentation follows the clock: tell the navigator about item and chapter changes and about the end of a still item. */
  private syncNavigator(s: Session): void {
    const nav = this.navigator;
    if (!nav || (this.state !== 'playing' && this.state !== 'paused') || this.held) return;
    const now = this.clock.nowUs();
    const { item } = s.timeline.locate(now);
    if (item.index !== this.navItem) {
      this.navItem = item.index;
      this.navEndReported = null;
      nav.playItemChanged(item.index);
    }
    // _playmark_reached: every mark passed since the last look, ENTRY or LINK, is one chapter PSR update
    let marksReached = false;
    // not while a seek of the navigator is still queued: the old position would report marks the program has left behind
    while (this.navSeeksPending === 0 && this.navNextMark >= 0 && now > s.timeline.markTimeUs(this.navNextMark)) {
      marksReached = true;
      this.navNextMark = this.navNextMark + 1 < s.timeline.markCount ? this.navNextMark + 1 : -1;
    }
    if (marksReached) {
      const clipTime45 = s.timeline.locate(now).clipTime45;
      nav.markReached(item.index, lookupSpn(this.disc?.clips.get(s.playItems[item.index]!.clipId), clipTime45, true));
    }
    const stillMode = s.playItems[item.index]?.stillMode ?? 0;
    if (this.state === 'playing' && stillMode !== 0 && this.navEndReported !== item.index && now >= s.timeline.itemStartUs(item.index) + ticks45ToUs(item.outTime - item.inTime) - STILL_MARGIN_US) {
      this.navEndReported = item.index;
      nav.playItemEnded(item.index);
    }
  }

  /** _find_next_playmark: the first mark after `timeUs`. */
  private nextMarkAfter(timeline: Timeline, timeUs: number): number {
    for (let i = 0; i < timeline.markCount; i++) if (timeline.markTimeUs(i) > timeUs) return i;
    return -1;
  }

  /**
   * `viaNavigator`: the navigator asked for it. Then the result says whether the playlist exists, and the navigator is told
   * of the start (playlistStarted) synchronously, before the first await.
   */
  private async playPlaylist(playlistId: string, at: PlayAt = {}, viaNavigator = false): Promise<boolean> {
    const source = this.source;
    const mpls = this.disc?.playlists.get(playlistId);
    if (!source || !mpls || mpls.playItems.length === 0) {
      if (viaNavigator) return false;
      throw new DiscError('missing-file', `Playlist ${playlistId} is not available.`, [playlistPath(playlistId)]);
    }
    const generation = ++this.openGeneration;
    this.teardownSession();
    const timeline = new Timeline(mpls.playItems, mpls.marks);
    const startUs = this.startTimeUs(timeline, at);
    const chapters = timeline.chapters(mpls.marks);
    const startItem = at.item !== undefined && at.item >= 0 && at.item < timeline.items.length ? at.item : timeline.locate(startUs).item.index;
    this.navItem = startItem;
    this.navEndReported = null;
    this.navNextMark = this.nextMarkAfter(timeline, startUs);
    if (viaNavigator && this.navigator) this.navigator.playlistStarted(playlistId, startItem);
    this.setState('loading');
    const clipIds = [...new Set(mpls.playItems.map((p) => p.clipId))];
    const clips = await loadClips(source, clipIds);
    await checkStreamReadable(source, clipIds[0]);
    if (generation !== this.openGeneration) return true; // superseded while loading

    const choice = chooseStreams(mpls.playItems[0].stn);
    if (!choice.video) {
      this.deps.emit({ type: 'error', code: 'no-video', message: 'This playlist has no video stream.', paths: [] });
      if (viaNavigator) return false;
      this.setState('error');
      return true;
    }
    if (!choice.audio && choice.unsupportedAudio.length > 0) {
      const codec = [...new Set(choice.unsupportedAudio.map((a) => codingName(a.codingType)))].join(', ');
      this.deps.emit({ type: 'unsupported', kind: 'audio', codec, message: `This playlist's audio (${codec}) can't be played yet, so video will play without sound.` });
    }
    if (!isSupportedVideoCoding(choice.video.codingType)) {
      throw new UnsupportedCodecError(choice.video.codingType, `${codingName(choice.video.codingType)} video is not supported.`);
    }
    // With a navigator the audio stream register (PSR1) decides, when it names a playable stream
    let audioIndex = choice.audioIndex;
    let audioEntry = choice.audio;
    const wanted = this.navRegs ? this.navRegs.psrRead(PSR.PRIMARY_AUDIO_ID) & 0xfff : 0;
    const wantedEntry = wanted > 0 ? audioEntryFor(mpls.playItems[startItem], wanted) : null;
    if (wantedEntry && PLAYABLE_AUDIO.has(wantedEntry.codingType)) {
      audioIndex = wanted;
      audioEntry = wantedEntry;
    }
    const audioActive = audioEntry !== null && this.ring !== null;
    if (audioEntry && !this.ring) this.notice('audio-disabled', 'Audio output is not available, so video will play without sound.');

    const decoder = new WebCodecsVideoDecoder(this.deps.videoCodecApi);
    const ref: { current: Session | null } = { current: null };
    const pipeline = new PlaybackPipeline(
      { source, timeline, clips, videoPid: choice.video.pid, playItems: mpls.playItems, audioStream: audioActive ? audioIndex : null, igStream: this.igStreamNumber() },
      {
        video: (u) => {
          if (ref.current) this.onVideoUnit(ref.current, u);
        },
        audio: (u) => {
          if (ref.current) this.onAudioUnit(ref.current, u);
        },
        ig: (u) => {
          // units of a superseded session or a torn-down navigator are dropped
          if (ref.current && ref.current === this.session) this.navigator?.pushIg(u);
        },
        pg: (u) => {
          // outside the play item's IN/OUT time PG is filtered out, as libbluray's m2ts_filter does
          if (ref.current && ref.current === this.session && u.inRange) this.pg?.push(u);
        },
        itemStarted: (index, startUs) => {
          if (ref.current) this.pgItemStarted(ref.current, index, startUs);
        },
        isFull: () => ref.current !== null && this.isFull(ref.current),
        ended: () => {
          if (ref.current) this.onPipelineEnded(ref.current);
        },
        failed: (err) => {
          if (ref.current && ref.current === this.session) this.fail(err);
        },
      },
    );
    const session: Session = {
      playlistId,
      timeline,
      chapters,
      tracks: audioTracks(mpls.playItems[startItem].stn),
      videoCodingType: choice.video.codingType,
      decoder,
      pipeline,
      playItems: mpls.playItems,
      audioStream: audioIndex,
      audioDecoders: new Map(),
      audioDecoderLoads: new Map(),
      audioErrorsInRow: 0,
      failedAudioTypes: new Set(),
      audioErrorDisabled: false,
      audioActive,
      decimator: null,
      videoState: 'unconfigured',
      pendingVideo: [],
      dropBeforeUs: 0,
      eof: false,
      flushed: false,
      flushStarted: false,
      audioStalledBeat: null,
      audioRecoveryQueued: false,
    };
    ref.current = session;
    decoder.onOutput = (frame) => {
      if (this.session === session) this.presenter.push(frame);
      else frame.close();
    };
    decoder.onError = (err) => this.onDecoderError(session, err);
    this.session = session;
    this.audioDecodeErrors = 0;
    this.audioCodec = null;
    this.sentPgTracks = '';
    this.deps.emit({ type: 'chapters', playlistId, durationUs: timeline.durationUs, chapters: session.chapters });
    this.emitTracks(session);
    await this.startAt(startUs, true);
    return true;
  }

  /** PG follows PSR2 of `regs`: the navigator's, or the disc's private registers when there is no navigator. */
  private bindPg(regs: RegisterFile): void {
    this.stopPg();
    this.pg = new PgStreamControl({
      regs,
      isMasked: (op) => this.navigator?.isMasked(op) ?? false,
      pidChanged: () => {
        // like an audio switch: re-read from now with the new PID, so the current subtitle shows without waiting for the next
        const s = this.session;
        if (s) this.enqueue(async () => {
          if (this.session === s) await this.startAt(this.clock.nowUs(), this.wantPlaying);
        });
      },
    });
    this.unsubscribePg = regs.onPsrEvent((e) => {
      if (e.type !== 'change' || e.psr !== PSR.PG_STREAM) return;
      // one subtitle choice at a time: the disc program turning a PG stream on hides the text track
      if (this.textOn && (e.newValue & 0x80000000) !== 0) {
        this.textOn = false;
        this.subtitlesDirty = true;
      }
      this.emitSubtitles();
    });
  }

  private stopPg(): void {
    this.unsubscribePg?.();
    this.unsubscribePg = null;
    this.pg?.stop();
    this.pg = null;
  }

  /** The reader opened a play item: _init_pg_stream, the PID for this item, and the track list when it changed. */
  private pgItemStarted(s: Session, index: number, startUs: number): void {
    const pg = this.pg;
    const item = s.playItems[index];
    if (!pg || !item || this.session !== s) return;
    pg.playItemStarted(item, this.navRegs === null, startUs);
    s.pipeline.setPgStream(pg.pid);
    if (JSON.stringify(pg.tracks()) !== this.sentPgTracks) this.emitSubtitles();
  }

  /**
   * One choice at a time: a PG stream (the text track hides), the text track (PG's display flag clears, so forced captions
   * stay), or Off. A change the disc's UO mask refuses changes nothing.
   */
  private selectSubtitle(choice: SubtitleChoice): void {
    const pg = this.pg;
    if (choice.kind === 'text') {
      if (!this.textTrack) return;
      if (pg && !pg.select('off')) this.notice('uo-masked', UO_MASKED_MESSAGE);
      else this.textOn = true;
    } else if (choice.kind === 'pg') {
      if (pg?.select({ pg: choice.stream })) this.textOn = false;
      else if (pg?.tracks().some((t) => t.index === choice.stream)) this.notice('uo-masked', UO_MASKED_MESSAGE);
    } else if (!pg || pg.select('off')) {
      this.textOn = false;
    } else {
      this.notice('uo-masked', UO_MASKED_MESSAGE);
    }
    this.subtitlesChanged();
  }

  private assDepsOnce(): Promise<AssDeps> | null {
    if (!this.deps.createAssDeps) return null;
    this.assDeps ??= this.deps.createAssDeps();
    return this.assDeps;
  }

  /** Every family a script names (styles and \fn), matched so its faces load before the first frame. */
  private static resolveFamilies(fonts: AssFonts, tracks: readonly AssTrack[]): void {
    for (const t of tracks) {
      // the styles events use, by their Style field or a \r tag (libass's built-in Default is often unused)
      const used = new Set(t.events.map((e) => e.style));
      for (const e of t.events) for (const m of e.text.matchAll(/\\r([^\\}]+)/g)) t.styles.forEach((st, i) => { if (st.name === m[1]) used.add(i); });
      for (const st of t.styles.filter((_, i) => used.has(i))) {
        const family = st.fontName.replace(/^@/, '');
        fonts.resolve({ family, bold: st.bold ? 700 : 400, italic: st.italic ? 100 : 0, vertical: st.fontName.startsWith('@') });
      }
      for (const e of t.events) {
        for (const m of e.text.matchAll(/\\fn([^\\}]*)/g)) {
          const name = m[1]!.trim();
          if (name && name !== '0') fonts.resolve({ family: name.replace(/^@/, ''), bold: 400, italic: 0, vertical: name.startsWith('@') });
        }
      }
    }
  }

  /**
   * Loads a subtitle set: decodes every file (one encoding prompt for the load), parses SRT or ASS, loads the
   * fonts the ASS files name, places the files on the current playlist and selects the text track.
   */
  private async addTextSubtitles(files: readonly FileData[], encoding: string | undefined, fontFiles: readonly FileData[]): Promise<void> {
    if (!this.disc) return;
    const generation = ++this.textLoadGeneration;
    const decoded: { name: string; text: string }[] = [];
    const needsEncoding: string[] = [];
    for (const f of files) {
      const d = decodeText(new Uint8Array(f.bytes), encoding);
      if ('needsEncoding' in d) needsEncoding.push(f.name);
      else decoded.push({ name: f.name, text: d.text });
    }
    if (needsEncoding.length) {
      this.deps.emit({ type: 'subtitleEncodingNeeded', names: needsEncoding });
      return;
    }
    const parsed: ({ name: string; format: 'srt'; cues: ReturnType<typeof parseSrt>['cues'] } | { name: string; format: 'ass'; track: AssTrack })[] = [];
    for (const { name, text } of decoded) {
      if (looksLikeAss(text)) {
        const track = parseAss(text);
        if (track.trackType === 'unknown' || track.events.length === 0) {
          this.notice('subtitle-file', `${name}: ${NO_SUBTITLES_MESSAGE}`);
          continue;
        }
        if (track.skippedLines * 2 > track.eventLines) this.notice('subtitle-file', SOME_SUBTITLES_MESSAGE);
        parsed.push({ name, format: 'ass', track });
      } else {
        const srt = parseSrt(text);
        if (srt.cues.length === 0) {
          this.notice('subtitle-file', `${name}: ${NO_SUBTITLES_MESSAGE}`);
          continue;
        }
        if (srt.skipped * 2 > srt.blocks) this.notice('subtitle-file', SOME_SUBTITLES_MESSAGE);
        parsed.push({ name, format: 'srt', cues: srt.cues });
      }
    }
    if (!parsed.length) return;

    const assTracks = parsed.flatMap((p) => (p.format === 'ass' ? [p.track] : []));
    let fonts: AssFonts | null = null;
    let deps: AssDeps | null = null;
    let unreadable: readonly string[] = [];
    if (assTracks.length) {
      const pending = this.assDepsOnce();
      if (!pending) return;
      deps = await pending;
      if (generation !== this.textLoadGeneration) return;
      fonts = new AssFonts(deps.loader, deps.defaultFont);
      // libass registers a script's [Fonts] before other fonts
      await fonts.add(assTracks.flatMap((t) => t.fonts));
      unreadable = (await fonts.add(fontFiles.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) })))).unreadable;
      Player.resolveFamilies(fonts, assTracks);
      await fonts.ready();
      if (generation !== this.textLoadGeneration || !this.disc) {
        fonts.dispose();
        return;
      }
    }

    const setFiles = sortByName(parsed.map((p): SetFile<TextRendererLike> => (p.format === 'srt'
      ? { name: p.name, format: 'srt', cues: p.cues.length, renderer: new TextSubtitleRenderer(p.cues) }
      : {
        name: p.name, format: 'ass', cues: p.track.events.length,
        renderer: new AssRenderer(p.track, fonts!, {
          measurer: deps!.measurer, createCanvas: deps!.createCanvas, nowMs: () => this.deps.nowMs(), Path2D: deps!.Path2D,
          colorMatrix: 'video', ...(deps!.warp ? { warp: deps!.warp } : {}),
        }),
      })));
    this.dropTextTrack();
    this.textTrack = { files: setFiles, renderer: new TextSetRenderer(new TextSet(setFiles)), fonts, assTracks, placedFor: null };
    this.placeTextFiles();
    if (unreadable.length) this.notice('subtitle-fonts', `Some font files could not be read: ${unreadable.join(', ')}`);
    const missing = fonts?.missingFamilies() ?? [];
    if (missing.length) this.notice('subtitle-fonts', `Some fonts are missing and were replaced: ${missing.join(', ')}`);
    this.selectSubtitle({ kind: 'text' });
  }

  /** More fonts for the set's ASS files: matched again, loaded, and the ASS files laid out again. */
  private async addSubtitleFonts(fontFiles: readonly FileData[]): Promise<void> {
    const track = this.textTrack;
    if (!track?.fonts) return;
    const generation = this.textLoadGeneration;
    const { unreadable } = await track.fonts.add(fontFiles.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) })));
    Player.resolveFamilies(track.fonts, track.assTracks);
    await track.fonts.ready();
    if (generation !== this.textLoadGeneration || this.textTrack !== track) return;
    for (const f of track.files) if (f.renderer instanceof AssRenderer) f.renderer.fontsChanged();
    if (unreadable.length) this.notice('subtitle-fonts', `Some font files could not be read: ${unreadable.join(', ')}`);
    this.subtitlesChanged();
  }

  /** Placements for the playing playlist: remembered ones, or by its episode starts (a notice when that fails). */
  private placeTextFiles(): void {
    const track = this.textTrack;
    const s = this.session;
    if (!track || !s || track.placedFor === s.playlistId) return;
    track.placedFor = s.playlistId;
    const { placed } = track.renderer.set.usePlaylist(s.playlistId, this.episodeStartsOf(s));
    if (!placed) this.notice('subtitle-file', PLACE_FILES_MESSAGE);
  }

  private episodeStartsOf(s: Session): number[] {
    return episodeStarts(s.timeline.items.map((i) => ({ startUs: ticks45ToUs(i.start), durationUs: ticks45ToUs(i.outTime - i.inTime) })));
  }

  private dropTextTrack(): void {
    this.textTrack?.fonts?.dispose();
    this.textTrack = null;
  }

  /** Forgets the text track and its settings (the disc it belongs to is closing). */
  private resetTextSubtitles(): void {
    this.textLoadGeneration++;
    this.dropTextTrack();
    this.textOn = false;
    this.textScale = 1;
    this.subtitlesDirty = true;
  }

  /** Offsets are per file in the set, which applies them. */
  private textOptions(): TextRenderOptions {
    return { offsetUs: 0, scale: this.textScale };
  }

  private subtitlesChanged(): void {
    this.subtitlesDirty = true;
    this.emitSubtitles();
  }

  private emitSubtitles(): void {
    const pg = this.pg;
    const tracks = pg?.tracks() ?? [];
    this.sentPgTracks = JSON.stringify(tracks);
    const { stream, display } = pg?.selection ?? { stream: 0, display: false };
    this.placeTextFiles();
    const track = this.textTrack;
    const placements = track?.renderer.set.placements() ?? [];
    this.deps.emit({
      type: 'subtitles',
      pg: tracks,
      text: track
        ? {
          files: track.files.map((f, i) => ({ name: f.name, format: f.format, cues: f.cues, startUs: placements[i]?.startUs ?? null, offsetMs: placements[i]?.offsetMs ?? 0 })),
          missingFonts: track.fonts?.missingFamilies() ?? [],
          episodeStarts: this.session ? this.episodeStartsOf(this.session) : [],
        }
        : null,
      selected: this.textOn && track ? 'text' : display && stream > 0 ? { pg: stream } : 'off',
      scale: this.textScale,
    });
  }

  /** PSR0, the IG stream number, with a navigator; discs without one show no menus. */
  private igStreamNumber(): number | null {
    const n = this.navRegs?.psrRead(PSR.IG_STREAM_ID) ?? 0;
    return n > 0 ? n : null;
  }

  private startTimeUs(timeline: Timeline, at: PlayAt): number {
    if (at.item !== undefined && at.item >= 0 && at.item < timeline.items.length) {
      const item = timeline.items[at.item]!;
      if (at.clipTime45 === undefined) return timeline.itemStartUs(at.item);
      const offset = Math.min(Math.max(0, at.clipTime45 - item.inTime), item.outTime - item.inTime);
      return ticks45ToUs(item.start + offset);
    }
    if (at.mark !== undefined) {
      try {
        return timeline.markTimeUs(at.mark);
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
      }
    }
    return 0;
  }

  private teardownSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.deps.emit({ type: 'playlistCleared' });
    this.seekGeneration++;
    s.pipeline.stop();
    this.pg?.seek();
    s.decoder.close();
    for (const d of s.audioDecoders.values()) d.close();
    s.audioDecoders.clear();
    this.presenter.clear();
    this.ring?.setPlaying(false);
    this.compositor?.drawVideo(null);
    this.wantPlaying = false;
  }

  private emitTracks(s: Session): void {
    this.deps.emit({ type: 'tracks', audio: s.tracks, selectedAudio: s.audioStream });
  }

  /** Switching is a re-seek to the current time with the new stream (a brief video refill). */
  private async selectAudio(index: number): Promise<void> {
    const nav = this.navigator;
    const s = this.session;
    if (nav && this.navRegs) {
      // The register change selects (applyAudio); a masked primaryAudioChange refuses the user's request
      if (this.refused('primaryAudioChange') || !s?.tracks.find((t) => t.index === index)?.playable) return;
      this.navRegs.psrWrite(PSR.PRIMARY_AUDIO_ID, index);
      await this.applyAudio(index); // the register event queued the same switch behind this command: it finds nothing to do
      return;
    }
    await this.applyAudio(index);
  }

  private async applyAudio(index: number): Promise<void> {
    const s = this.session;
    if (!s || index === s.audioStream || this.state === 'error') return;
    if (!s.tracks.find((t) => t.index === index)?.playable) return;
    s.audioStream = index;
    s.audioActive = this.ring !== null;
    s.audioErrorDisabled = false;
    s.audioStalledBeat = null;
    this.emitTracks(s);
    await this.startAt(this.clock.nowUs(), this.wantPlaying);
  }

  private async startAt(targetUs: number, autoplay: boolean): Promise<void> {
    const s = this.session;
    if (!s) return;
    const gen = ++this.seekGeneration;
    this.navEndReported = null;
    const t = Math.min(Math.max(0, targetUs), Math.max(0, s.timeline.durationUs - 1));
    this.navNextMark = this.nextMarkAfter(s.timeline, t);
    s.pipeline.stop();
    this.navigator?.seekGraphics(); // queued units from the old read position are dropped; the menu stays
    this.pg?.seek(); // GC_CTRL_PG_RESET in _seek_internal: the subtitle on screen goes
    if (s.videoState === 'configured') s.decoder.reset();
    s.pendingVideo = [];
    s.decimator?.reset();
    s.eof = false;
    s.flushed = false;
    s.flushStarted = false;
    if (this.audioRecovered(s)) {
      s.audioActive = true;
      s.audioStalledBeat = null;
    }
    s.audioRecoveryQueued = false;
    if (s.audioErrorDisabled && this.ring) {
      s.audioActive = true;
      s.audioErrorDisabled = false;
    }
    s.audioErrorsInRow = 0;
    s.failedAudioTypes.clear();
    for (const d of s.audioDecoders.values()) d.reset();
    const audioType = s.audioActive ? this.audioCodingTypeAt(s, t) : null;
    if (audioType !== null) {
      // The decoder may take a while to load (first WASM compile): stop the old audio and clock and show buffering meanwhile.
      this.wantPlaying = false;
      this.setState(autoplay ? 'buffering' : 'paused');
      this.presenter.clear();
      this.ring?.setPlaying(false);
      this.clock.useWall(this.clock.nowUs(), false);
      try {
        await this.loadAudioDecoder(s, audioType);
      } catch (err) {
        if (gen !== this.seekGeneration) return;
        this.audioUnavailable(s, audioType, err);
      }
      if (gen !== this.seekGeneration) return;
    }
    s.dropBeforeUs = t - SEEK_TOLERANCE_US;
    this.presenter.clear();
    this.offsets = [];
    this.wantPlaying = autoplay;
    this.setState(autoplay ? 'buffering' : 'paused');

    const ring = this.ring;
    if (s.audioActive && ring && this.audioWriter) {
      ring.setPlaying(false);
      await ring.requestDiscard();
      if (gen !== this.seekGeneration) return;
      this.clock.useAudio(ring, t);
      this.audioWriter.start(t);
    } else {
      this.clock.useWall(t, false);
    }
    this.emitTime(t, true);
    s.pipeline.setAudioStream(s.audioActive ? s.audioStream : null);
    s.pipeline.setIgStream(this.igStreamNumber());
    s.pipeline.start(t);
  }

  private async play(): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (this.state === 'ended') {
      await this.startAt(0, true);
      return;
    }
    if (this.state === 'paused' && this.audioRecovered(s)) {
      await this.startAt(this.clock.nowUs(), true); // rebase onto the recovered audio output
      return;
    }
    this.wantPlaying = true;
    if (this.state === 'paused') this.setState('buffering');
  }

  /** Audio was disabled by a stalled output that has since started running again. */
  private audioRecovered(s: Session): boolean {
    return s.audioStalledBeat !== null && this.ring !== null && this.ring.heartbeat() !== s.audioStalledBeat;
  }

  private close(): void {
    this.stopNavigator();
    this.teardownSession();
    this.stopPg();
    this.pgRegs = null;
    this.resetTextSubtitles();
    this.emitSubtitles();
    this.source = null;
    this.disc = null;
    this.setState('idle');
  }

  private pause(): void {
    if (!this.session) return;
    this.wantPlaying = false;
    this.ring?.setPlaying(false);
    this.clock.setRunning(false);
    if (this.state === 'playing' || this.state === 'buffering') this.setState('paused');
  }

  private async skipChapter(direction: 1 | -1): Promise<void> {
    const s = this.session;
    if (!s || s.chapters.length === 0) return;
    const now = this.clock.nowUs();
    let target: number | undefined;
    if (direction > 0) {
      target = s.chapters.find((c) => c.startUs > now + NEXT_CHAPTER_GUARD_US)?.startUs;
    } else {
      target = [...s.chapters].reverse().find((c) => c.startUs < now - PREV_CHAPTER_RESTART_US)?.startUs ?? 0;
    }
    if (target !== undefined) {
      this.notifySeeked(target);
      await this.startAt(target, this.wantPlaying);
    }
  }

  private onVideoUnit(s: Session, u: PipelineUnit): void {
    const unit: VideoUnit = { data: u.data, ptsUs: u.ptsUs, discard: !u.inRange || u.ptsUs < s.dropBeforeUs };
    switch (s.videoState) {
      case 'configured':
        s.pendingVideo.push(unit);
        this.feedDecoder(s);
        return;
      case 'failed':
        return;
      case 'configuring':
        s.pendingVideo.push(unit);
        return;
      case 'unconfigured':
        if (!hasSps(s.videoCodingType, u.data)) return;
        s.videoState = 'configuring';
        s.pendingVideo.push(unit);
        s.decoder.configure({ codingType: s.videoCodingType, firstUnit: u.data }).then(
          () => {
            if (this.session !== s) {
              s.decoder.close(); // configure() finished after teardown and opened a fresh decoder
              return;
            }
            s.videoState = 'configured';
            this.feedDecoder(s);
          },
          (err: unknown) => {
            if (this.session !== s) return;
            s.videoState = 'failed';
            this.fail(err);
          },
        );
    }
  }

  /** Coding type of the selected audio stream in the play item containing `timeUs`, if playable. */
  private audioCodingTypeAt(s: Session, timeUs: number): number | null {
    const entry = audioEntryFor(s.playItems[s.timeline.locate(timeUs).item.index], s.audioStream);
    return entry && PLAYABLE_AUDIO.has(entry.codingType) ? entry.codingType : null;
  }

  /** One load per coding type per session; a decoder that arrives after teardown is closed. */
  private loadAudioDecoder(s: Session, codingType: number): Promise<AudioDecoder> {
    let load = s.audioDecoderLoads.get(codingType);
    if (!load) {
      const p = this.deps.createAudioDecoder(codingType);
      load = p;
      s.audioDecoderLoads.set(codingType, p);
      p.then(
        (d) => {
          if (this.session === s) s.audioDecoders.set(codingType, d);
          else d.close();
        },
        () => {
          if (s.audioDecoderLoads.get(codingType) === p) s.audioDecoderLoads.delete(codingType);
        },
      );
    }
    return load;
  }

  private audioUnavailable(s: Session, codingType: number, err: unknown): void {
    const codec = codingName(codingType);
    const reason = err instanceof Error ? err.message : String(err);
    this.deps.emit({ type: 'unsupported', kind: 'audio', codec, message: `${codec} audio can't be played (${reason}), so video will play without sound.` });
    this.disableAudio(s, '', false); // also stops the ring (it still holds the previous track or position) and moves the clock to wall time
  }

  private onAudioUnit(s: Session, u: PipelineAudioUnit): void {
    const writer = this.audioWriter;
    if (!s.audioActive || !writer) return;
    const decoder = s.audioDecoders.get(u.codingType);
    if (!decoder) {
      // A later item switched codec: load its decoder (ready for its next units); give up once if that is impossible.
      const type = u.codingType;
      if (s.failedAudioTypes.has(type)) return;
      if (!PLAYABLE_AUDIO.has(type)) {
        s.failedAudioTypes.add(type);
        this.audioUnavailable(s, type, new Error(`${codingName(type)} audio is not supported.`));
        return;
      }
      const gen = this.seekGeneration;
      this.loadAudioDecoder(s, type).catch((err: unknown) => {
        // Only the read that saw these units may give up on them: after a seek, startAt owns the outcome.
        if (this.session !== s || this.seekGeneration !== gen || !s.audioActive || s.failedAudioTypes.has(type)) return;
        s.failedAudioTypes.add(type);
        this.audioUnavailable(s, type, err);
      });
      return;
    }
    let result: AudioDecodeResult;
    try {
      result = decoder.decode(u); // out-of-range units still go in, to keep decoder state continuous
    } catch (err) {
      if (!(err instanceof UnsupportedCodecError)) throw err;
      this.deps.emit({ type: 'unsupported', kind: 'audio', codec: codingName(err.codingType), message: err.message });
      this.disableAudio(s, err.message, false);
      return;
    }
    if (result.failedFrames > 0) {
      this.audioDecodeErrors += result.failedFrames;
      s.audioErrorsInRow += result.failedFrames;
      if (s.audioErrorsInRow > MAX_AUDIO_ERRORS_IN_ROW) {
        s.audioErrorDisabled = true;
        this.disableAudio(s, `The ${codingName(u.codingType)} audio is too damaged to play, so playback continues without sound.`);
        return;
      }
    }
    if (result.chunks.length > 0) {
      s.audioErrorsInRow = 0;
      this.audioCodec = codingName(u.codingType);
    }
    if (!u.inRange) return;
    for (let chunk of result.chunks) {
      if (chunk.sampleRate !== OUTPUT_SAMPLE_RATE) {
        const factor = chunk.sampleRate / OUTPUT_SAMPLE_RATE;
        if (!s.decimator || s.decimator.factor !== factor) s.decimator = new Decimator(factor);
        chunk = s.decimator.process(chunk);
      }
      writer.enqueue(chunk);
    }
  }

  private isFull(s: Session): boolean {
    // Rendering can be throttled (background tab); drop late frames here so reading never stalls on them.
    if (this.state === 'playing') this.presenter.dropLate(this.clock.nowUs());
    this.feedDecoder(s);
    this.audioWriter?.drain();
    return this.readerBlocked(s) || (s.audioActive && (this.audioWriter?.queuedChunks ?? 0) > 0);
  }

  /** Moves compressed video into the decoder while the decoded-frame and decode-queue caps allow. */
  private feedDecoder(s: Session): void {
    if (s.videoState !== 'configured') return;
    let fed = 0;
    while (fed < s.pendingVideo.length && this.presenter.size < MAX_QUEUED_FRAMES && s.decoder.queueSize < MAX_DECODE_QUEUE) {
      s.decoder.decode(s.pendingVideo[fed]);
      fed++;
    }
    if (fed > 0) s.pendingVideo = s.pendingVideo.slice(fed);
    if (s.eof && s.pendingVideo.length === 0 && !s.flushStarted) this.flushDecoder(s);
  }

  /** True when the compressed-video backlog has used its read-ahead budget, so reading must wait. */
  private readerBlocked(s: Session): boolean {
    const pending = s.pendingVideo;
    if (pending.length === 0) return false;
    let min = Infinity;
    let max = -Infinity;
    let bytes = 0;
    for (const u of pending) {
      if (u.ptsUs < min) min = u.ptsUs;
      if (u.ptsUs > max) max = u.ptsUs;
      bytes += u.data.length;
    }
    return max - min >= MAX_ENCODED_VIDEO_US || bytes >= MAX_ENCODED_VIDEO_BYTES;
  }

  private onPipelineEnded(s: Session): void {
    s.eof = true;
    if (s.videoState !== 'configured') {
      s.flushed = true;
      return;
    }
    this.feedDecoder(s); // flushes once the compressed backlog has drained
  }

  private flushDecoder(s: Session): void {
    s.flushStarted = true;
    const gen = this.seekGeneration;
    void s.decoder.flush().then(() => {
      if (this.session === s && this.seekGeneration === gen) s.flushed = true;
    });
  }

  private onDecoderError(s: Session, err: DecoderError): void {
    if (this.session !== s) return;
    this.decoderErrors++;
    if (!err.fatal) {
      this.notice('decoder-recovered', err.message);
      return;
    }
    s.videoState = 'failed';
    s.pipeline.stop();
    this.deps.emit({ type: 'error', code: 'decoder-failed', message: err.message, paths: [] });
    this.pause();
    this.setState('error');
  }

  private updatePlayback(s: Session): void {
    if (this.held) return; // a still image: the output is stopped on purpose, so neither stall detection nor start-up applies
    if (this.state === 'playing' && !s.audioRecoveryQueued && this.audioRecovered(s)) {
      // The stalled output runs again (often just a slow start while another client opened a stream):
      // move back onto it with a seek to the current time, queued like any other command.
      s.audioRecoveryQueued = true;
      void this.handle({ type: 'seek', timeUs: this.clock.nowUs() });
    }
    const ring = s.audioActive ? this.ring : null;
    if (this.state === 'buffering' && this.wantPlaying) {
      const audioReady =
        !ring ||
        s.eof ||
        this.readerBlocked(s) ||
        (this.audioWriter?.queuedChunks ?? 0) > 0 ||
        (ring.buffered() * 1e6) / ring.sampleRate >= AUDIO_PREBUFFER_US;
      const videoReady = this.presenter.size > 0 || this.presenter.current !== null || s.eof || s.videoState === 'failed';
      if (!audioReady || !videoReady) return;
      if (ring) {
        ring.setPlaying(true);
        this.lastHeartbeat = ring.heartbeat();
        this.lastHeartbeatChangeMs = this.deps.nowMs();
      } else {
        this.clock.setRunning(true);
      }
      this.setState('playing');
      return;
    }
    if (this.state !== 'playing' || !ring) return;

    const beat = ring.heartbeat();
    const nowMs = this.deps.nowMs();
    if (beat !== this.lastHeartbeat) {
      this.lastHeartbeat = beat;
      this.lastHeartbeatChangeMs = nowMs;
    } else if (nowMs - this.lastHeartbeatChangeMs > HEARTBEAT_TIMEOUT_MS) {
      this.disableAudio(s, 'Audio output is not running (the browser may have blocked it), so playback continues without sound.');
      s.audioStalledBeat = beat;
      return;
    }
    if (s.eof && (this.audioWriter?.queuedChunks ?? 0) === 0) {
      // Audio is decoded as it arrives, so after EOF everything is in the ring: the video may still need a few frames
      // and the output keeps running (and the clock with it) through silence that is no underrun.
      ring.setDraining(true);
    } else if (!s.eof && ring.buffered() === 0 && !this.readerBlocked(s)) {
      ring.setPlaying(false);
      this.setState('buffering');
    }
  }

  private disableAudio(s: Session, message: string, notify = true): void {
    if (!s.audioActive) return;
    const now = this.clock.nowUs();
    s.audioActive = false;
    this.ring?.setPlaying(false);
    this.clock.useWall(now, this.state === 'playing');
    if (notify) this.notice('audio-disabled', message);
  }

  private emitTime(timeUs: number, force: boolean): void {
    if (!force && Math.abs(timeUs - this.lastTimeEmitted) < TIME_EVENT_INTERVAL_US) return;
    this.lastTimeEmitted = timeUs;
    this.deps.emit({ type: 'time', timeUs: Math.round(timeUs) });
  }

  private maybeEmitTelemetry(s: Session): void {
    const nowMs = this.deps.nowMs();
    if (nowMs - this.lastTelemetryMs < TELEMETRY_INTERVAL_MS) return;
    this.lastTelemetryMs = nowMs;
    const offsets = this.offsets;
    this.offsets = [];
    const ring = this.ring;
    const stats = s.pipeline.stats;
    this.deps.emit({
      type: 'telemetry',
      telemetry: {
        clockUs: this.clock.nowUs(),
        clockMode: this.clock.mode,
        avOffsetMeanUs: offsets.length > 0 ? offsets.reduce((a, b) => a + b, 0) / offsets.length : null,
        avOffsetMaxAbsUs: offsets.length > 0 ? Math.max(...offsets.map((o) => Math.abs(o))) : null,
        framesInWindow: offsets.length,
        framesPresented: this.presenter.presented,
        framesDropped: this.presenter.dropped,
        audioBufferedMs: ring ? (ring.buffered() * 1000) / ring.sampleRate : 0,
        audioUnderruns: ring?.underruns() ?? 0,
        corruptPackets: stats.corruptPackets + this.audioDecodeErrors,
        audioCodec: this.audioCodec,
        audioDecodeErrors: this.audioDecodeErrors,
        continuityErrors: stats.continuityErrors,
        decoderErrors: this.decoderErrors,
        openGopStarts: s.decoder.openGop.starts,
        leadingPicturesSkipped: s.decoder.openGop.leadingSkipped,
        menu: this.menuActive && this.navRegs ? { page: this.navRegs.psrRead(PSR.MENU_PAGE_ID), selectedButton: this.navRegs.psrRead(PSR.SELECTED_BUTTON_ID), buttonsDrawn: this.igDraws } : null,
        igErrors: this.navigator?.igErrors ?? 0,
        soundsPlayed: this.soundsPlayed,
        pg: this.pg?.shown ?? null,
        pgErrors: this.pg?.errors ?? 0,
        textCue: this.textCueVisible(),
        textFile: this.textOn ? this.textTrack?.renderer.fileAt(this.clock.nowUs())?.file ?? null : null,
        ass: this.assStats(),
        shader: this.shaderStage?.stats ?? null,
      },
    });
  }

  private textCueVisible(): boolean {
    const track = this.textTrack;
    return this.textOn && track !== null && track.renderer.visible(this.clock.nowUs(), this.textOptions());
  }

  private assStats(): { events: number; animated: number; renderMs: number; overBudget: number; renders: number } | null {
    const showing = this.textOn ? this.textTrack?.renderer.fileAt(this.clock.nowUs())?.renderer : undefined;
    return showing instanceof AssRenderer ? showing.stats() : null;
  }

  /** A user operation the disc masks here: refused with a notice. Discs without a navigator mask nothing. */
  private refused(op: UoOp): boolean {
    if (!this.navigator?.isMasked(op)) return false;
    this.notice('uo-masked', UO_MASKED_MESSAGE);
    return true;
  }

  private notice(code: NoticeCode, message: string): void {
    this.deps.emit({ type: 'notice', code, message });
  }

  private setState(state: PlaybackState): void {
    if (state === this.state) return;
    this.state = state;
    this.deps.emit({ type: 'state', state });
  }

  private fail(err: unknown): void {
    this.reportError(err);
    this.session?.pipeline.stop();
    this.wantPlaying = false;
    this.ring?.setPlaying(false);
    this.clock.setRunning(false);
    this.setState('error');
  }

  private reportError(err: unknown): void {
    if (err instanceof DiscError) {
      this.deps.emit({ type: 'error', code: err.code, message: err.message, paths: err.paths });
    } else if (err instanceof UnsupportedCodecError) {
      this.deps.emit({ type: 'unsupported', kind: isVideoCoding(err.codingType) ? 'video' : 'audio', codec: codingName(err.codingType), message: err.message });
    } else if (err instanceof ParseError) {
      this.deps.emit({ type: 'error', code: 'corrupt-disc', message: `The disc data is damaged: ${err.message}`, paths: [] });
    } else {
      this.deps.emit({ type: 'error', code: 'internal', message: err instanceof Error ? err.message : String(err), paths: [] });
    }
  }
}
