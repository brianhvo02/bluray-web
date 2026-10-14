import { AudioWriter } from './audio/audio-writer';
import { OUTPUT_SAMPLE_RATE, RingWriter, ringViews } from './audio/ring';
import { type PlayItem } from './bdmv/mpls-parser';
import { codingName, isVideoCoding } from './bdmv/stream-types';
import { MasterClock } from './clock/master-clock';
import { Decimator } from './decode/decimator';
import { UnsupportedCodecError, type DecoderError } from './decode/decoder';
import { type AudioDecodeResult, type AudioDecoder, type AudioDecoderFactory } from './decode/audio-decoder';
import { WebCodecsVideoDecoder, hasSps, isSupportedVideoCoding, type VideoCodecApi, type VideoUnit } from './decode/video-decoder';
import { DiscError } from './disc/byte-source';
import { FileSource } from './disc/file-source';
import { checkStreamReadable, loadClips, openDisc, playlistPath, type DiscModel } from './disc/open-disc';
import { normalizeDiscPaths } from './disc/paths';
import { PSR, RegisterFile, type PsrEvent } from './hdmv/registers';
import { Navigator, type NavigatorEvent, type PlaybackPort, type PlayAt } from './nav/navigator';
import { Timeline, type Chapter } from './nav/timeline';
import { PlaybackPipeline, type PipelineAudioUnit, type PipelineUnit } from './playback/pipeline';
import { PLAYABLE_AUDIO, audioEntryFor, chooseStreams } from './playback/stream-selection';
import { audioTracks } from './playback/tracks';
import type { AudioTrack, EngineCommand, EngineEvent, NoticeCode, PlaybackState } from './protocol';
import type { CompositorLike } from './render/compositor';
import { VideoPresenter } from './render/video-presenter';
import { ParseError } from './util/byte-reader';
import { ticks45ToUs } from './util/time';

export interface PlayerDeps {
  emit(event: EngineEvent): void;
  readonly videoCodecApi: VideoCodecApi;
  nowMs(): number;
  requestFrame(callback: () => void): void;
  createCompositor(canvas: OffscreenCanvas): CompositorLike;
  readonly createAudioDecoder: AudioDecoderFactory;
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
  /** Presentation is frozen (still image): the clock and audio output are stopped. */
  private held = false;
  /** The play item whose end was reported to the navigator; reset on an item change and on every seek. */
  private navEndReported: number | null = null;
  private menuActive = false;
  private popupAvailable = false;
  /** Bumped by every playlist open and by navigator teardown, so a superseded open stops early. */
  private openGeneration = 0;

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
          this.startRenderLoop();
          break;
        case 'attachAudio':
          this.ring = new RingWriter(ringViews(cmd.ring));
          this.audioWriter = new AudioWriter(this.ring);
          break;
        case 'resize':
          this.compositor?.resize(cmd.width, cmd.height);
          this.compositor?.drawVideo(this.presenter.current);
          break;
        case 'playPlaylist':
          this.stopNavigator();
          await this.playPlaylist(cmd.playlistId);
          break;
        case 'playTitle':
          this.navigator?.playTitle(cmd.title);
          break;
        case 'menuCall':
          this.navigator?.menuCall();
          break;
        case 'play':
          await this.play();
          break;
        case 'pause':
          this.pause();
          break;
        case 'close':
          this.close();
          break;
        case 'seek':
          await this.startAt(cmd.timeUs, this.wantPlaying);
          break;
        case 'selectAudio':
          await this.selectAudio(cmd.index);
          break;
        case 'nextChapter':
          await this.skipChapter(1);
          break;
        case 'prevChapter':
          await this.skipChapter(-1);
          break;
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /** One render tick (requestAnimationFrame in the worker; called directly by tests). */
  tick(): void {
    this.navigator?.tick();
    const s = this.session;
    if (!s) return;
    this.updatePlayback(s);
    this.syncNavigator(s);
    const now = this.clock.nowUs();
    const frame = this.presenter.select(now);
    if (frame) {
      this.compositor?.drawVideo(frame);
      if (this.state === 'playing') this.offsets.push(now - frame.timestamp);
    }
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
    this.deps.emit({ type: 'titles', playlists: disc.summaries, usesBdj: disc.usesBdj, warnings: disc.warnings });
    if (disc.movieObjects) this.emitIndexTitles(disc);
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
    regs.onPsrEvent((e) => this.onPsrEvent(e, regs));
    this.navRegs = regs;
    this.menuActive = false;
    this.popupAvailable = false;
    return new Navigator({
      disc,
      regs,
      port: this.navigationPort(),
      emit: (e) => this.onNavigatorEvent(e),
      nowScr: () => this.deps.nowMs() * SCR_PER_MS,
    });
  }

  /** Drops the navigator (and with it the VM and the registers) and releases a hold. */
  private stopNavigator(): void {
    const nav = this.navigator;
    if (!nav) return;
    this.navigator = null;
    this.navRegs = null;
    this.openGeneration++;
    nav.stop();
    this.setHold(false);
    this.updateMenuState(false, false);
    this.deps.emit({ type: 'uoMask', masked: [] });
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
      default:
        break; // 'title' and 'sound' are for the menu UI
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
        if (s && item >= 0 && item < s.timeline.items.length) this.enqueue(async () => this.session === s ? this.startAt(s.timeline.itemStartUs(item), this.wantPlaying) : undefined);
      },
      seekMark: (mark) => {
        const s = this.session;
        if (!s) return;
        try {
          const t = s.timeline.markTimeUs(mark);
          this.enqueue(async () => this.session === s ? this.startAt(t, this.wantPlaying) : undefined);
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
    while (this.navNextMark >= 0 && now > s.timeline.markTimeUs(this.navNextMark)) {
      marksReached = true;
      this.navNextMark = this.navNextMark + 1 < s.timeline.markCount ? this.navNextMark + 1 : -1;
    }
    if (marksReached) nav.markReached(item.index, s.timeline.locate(now).clipTime45);
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
      { source, timeline, clips, videoPid: choice.video.pid, playItems: mpls.playItems, audioStream: audioActive ? audioIndex : null },
      {
        video: (u) => {
          if (ref.current) this.onVideoUnit(ref.current, u);
        },
        audio: (u) => {
          if (ref.current) this.onAudioUnit(ref.current, u);
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
    this.deps.emit({ type: 'chapters', playlistId, durationUs: timeline.durationUs, chapters: session.chapters });
    this.emitTracks(session);
    await this.startAt(startUs, true);
    return true;
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
      if (nav.isMasked('primaryAudioChange') || !s?.tracks.find((t) => t.index === index)?.playable) return;
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
    if (target !== undefined) await this.startAt(target, this.wantPlaying);
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
    if (!s.eof && ring.buffered() === 0 && !this.readerBlocked(s)) {
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
      },
    });
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
