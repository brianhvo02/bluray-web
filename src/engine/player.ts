import { AudioWriter } from './audio/audio-writer';
import { RingWriter, ringViews } from './audio/ring';
import { codingName, isVideoCoding } from './bdmv/stream-types';
import { MasterClock } from './clock/master-clock';
import { Decimator } from './decode/decimator';
import { UnsupportedCodecError, type DecoderError } from './decode/decoder';
import { decodeLpcm, type PcmChunk } from './decode/lpcm';
import { WebCodecsVideoDecoder, hasSps, type VideoCodecApi, type VideoUnit } from './decode/video-decoder';
import { DiscError } from './disc/byte-source';
import { FileSource } from './disc/file-source';
import { checkStreamReadable, loadClips, openDisc, playlistPath, type DiscModel } from './disc/open-disc';
import { normalizeDiscPaths } from './disc/paths';
import { Timeline, type Chapter } from './nav/timeline';
import { PlaybackPipeline, type PipelineUnit } from './playback/pipeline';
import { chooseStreams } from './playback/stream-selection';
import type { EngineCommand, EngineEvent, NoticeCode, PlaybackState } from './protocol';
import type { CompositorLike } from './render/compositor';
import { VideoPresenter } from './render/video-presenter';
import { ParseError } from './util/byte-reader';

export interface PlayerDeps {
  emit(event: EngineEvent): void;
  readonly videoCodecApi: VideoCodecApi;
  nowMs(): number;
  requestFrame(callback: () => void): void;
  createCompositor(canvas: OffscreenCanvas): CompositorLike;
}

const OUTPUT_SAMPLE_RATE = 48_000;
const MAX_QUEUED_FRAMES = 8;
const MAX_DECODE_QUEUE = 8;
const MAX_PENDING_VIDEO = 64;
const AUDIO_PREBUFFER_US = 200_000;
const TIME_EVENT_INTERVAL_US = 250_000;
const TELEMETRY_INTERVAL_MS = 500;
const HEARTBEAT_TIMEOUT_MS = 500;
/** Frames up to this far before a seek target are still shown (EP pts are truncated by up to ~5.7 ms). */
const SEEK_TOLERANCE_US = 1_000;
const NEXT_CHAPTER_GUARD_US = 500_000;
const PREV_CHAPTER_RESTART_US = 3_000_000;

interface Session {
  readonly playlistId: string;
  readonly timeline: Timeline;
  readonly chapters: readonly Chapter[];
  readonly videoCodingType: number;
  readonly decoder: WebCodecsVideoDecoder;
  readonly pipeline: PlaybackPipeline;
  audioActive: boolean;
  decimator: Decimator | null;
  videoState: 'unconfigured' | 'configuring' | 'configured' | 'failed';
  pendingVideo: VideoUnit[];
  dropBeforeUs: number;
  eof: boolean;
  flushed: boolean;
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

  constructor(private readonly deps: PlayerDeps) {
    this.clock = new MasterClock(deps.nowMs);
  }

  async handle(cmd: EngineCommand): Promise<void> {
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
          await this.playPlaylist(cmd.playlistId);
          break;
        case 'play':
          this.play();
          break;
        case 'pause':
          this.pause();
          break;
        case 'seek':
          await this.startAt(cmd.timeUs, this.wantPlaying);
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
    const s = this.session;
    if (!s) return;
    this.updatePlayback(s);
    const now = this.clock.nowUs();
    const frame = this.presenter.select(now);
    if (frame) {
      this.compositor?.drawVideo(frame);
      if (this.state === 'playing') this.offsets.push(now - frame.timestamp);
    }
    const last = this.presenter.current;
    if (this.state === 'playing' && s.flushed && this.presenter.size === 0 && now >= (last?.timestamp ?? 0) + 100_000) {
      this.wantPlaying = false;
      this.ring?.setPlaying(false);
      this.clock.setRunning(false);
      this.setState('ended');
    }
    this.emitTime(Math.min(now, s.timeline.durationUs), false);
    this.maybeEmitTelemetry(s);
  }

  private startRenderLoop(): void {
    if (this.renderLoopStarted) return;
    this.renderLoopStarted = true;
    const loop = (): void => {
      this.tick();
      this.deps.requestFrame(loop);
    };
    this.deps.requestFrame(loop);
  }

  private async open(entries: ReadonlyArray<readonly [string, Blob]>): Promise<void> {
    this.teardownSession();
    this.setState('loading');
    const source = new FileSource(normalizeDiscPaths(entries));
    const disc = await openDisc(source);
    this.source = source;
    this.disc = disc;
    this.deps.emit({ type: 'titles', playlists: disc.summaries, usesBdj: disc.usesBdj, warnings: disc.warnings });
    if (disc.usesBdj) this.notice('bdj', 'This disc uses BD-J (Java) menus, which are not supported. Choose a playlist to play.');
    this.setState('idle');
  }

  private async playPlaylist(playlistId: string): Promise<void> {
    const source = this.source;
    const mpls = this.disc?.playlists.get(playlistId);
    if (!source || !mpls || mpls.playItems.length === 0) {
      throw new DiscError('missing-file', `Playlist ${playlistId} is not available.`, [playlistPath(playlistId)]);
    }
    this.teardownSession();
    this.setState('loading');
    const clipIds = [...new Set(mpls.playItems.map((p) => p.clipId))];
    const clips = await loadClips(source, clipIds);
    await checkStreamReadable(source, clipIds[0]);

    const choice = chooseStreams(mpls.playItems[0].stn);
    if (!choice.video) {
      this.deps.emit({ type: 'error', code: 'no-video', message: 'This playlist has no video stream.', paths: [] });
      this.setState('error');
      return;
    }
    if (!choice.audio && choice.unsupportedAudio.length > 0) {
      const codec = [...new Set(choice.unsupportedAudio.map((a) => codingName(a.codingType)))].join(', ');
      this.deps.emit({ type: 'unsupported', kind: 'audio', codec, message: `This playlist's audio (${codec}) can't be played yet, so video will play without sound.` });
    }
    const audioActive = choice.audio !== null && this.ring !== null;
    if (choice.audio && !this.ring) this.notice('audio-disabled', 'Audio output is not available, so video will play without sound.');

    const timeline = new Timeline(mpls.playItems);
    const decoder = new WebCodecsVideoDecoder(this.deps.videoCodecApi);
    const ref: { current: Session | null } = { current: null };
    const pipeline = new PlaybackPipeline(
      { source, timeline, clips, videoPid: choice.video.pid, audioPid: audioActive && choice.audio ? choice.audio.pid : null },
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
      chapters: timeline.chapters(mpls.marks),
      videoCodingType: choice.video.codingType,
      decoder,
      pipeline,
      audioActive,
      decimator: null,
      videoState: 'unconfigured',
      pendingVideo: [],
      dropBeforeUs: 0,
      eof: false,
      flushed: false,
    };
    ref.current = session;
    decoder.onOutput = (frame) => {
      if (this.session === session) this.presenter.push(frame);
      else frame.close();
    };
    decoder.onError = (err) => this.onDecoderError(session, err);
    this.session = session;
    this.deps.emit({ type: 'chapters', playlistId, durationUs: timeline.durationUs, chapters: session.chapters });
    await this.startAt(0, true);
  }

  private teardownSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.seekGeneration++;
    s.pipeline.stop();
    s.decoder.close();
    this.presenter.clear();
    this.ring?.setPlaying(false);
    this.compositor?.drawVideo(null);
    this.wantPlaying = false;
  }

  private async startAt(targetUs: number, autoplay: boolean): Promise<void> {
    const s = this.session;
    if (!s) return;
    const gen = ++this.seekGeneration;
    const t = Math.min(Math.max(0, targetUs), Math.max(0, s.timeline.durationUs - 1));
    s.pipeline.stop();
    if (s.videoState === 'configured') s.decoder.reset();
    s.pendingVideo = [];
    s.decimator?.reset();
    s.eof = false;
    s.flushed = false;
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
    s.pipeline.start(t);
  }

  private play(): void {
    if (!this.session) return;
    if (this.state === 'ended') {
      void this.startAt(0, true).catch((err: unknown) => this.fail(err));
      return;
    }
    this.wantPlaying = true;
    if (this.state === 'paused') this.setState('buffering');
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
        s.decoder.decode(unit);
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
            if (this.session !== s) return;
            s.videoState = 'configured';
            const pending = s.pendingVideo;
            s.pendingVideo = [];
            for (const p of pending) s.decoder.decode(p);
          },
          (err: unknown) => {
            if (this.session !== s) return;
            s.videoState = 'failed';
            this.fail(err);
          },
        );
    }
  }

  private onAudioUnit(s: Session, u: PipelineUnit): void {
    const writer = this.audioWriter;
    if (!s.audioActive || !writer || !u.inRange) return;
    let chunk: PcmChunk;
    try {
      chunk = decodeLpcm(u.data, u.ptsUs);
    } catch (err) {
      if (err instanceof UnsupportedCodecError) {
        this.deps.emit({ type: 'unsupported', kind: 'audio', codec: codingName(err.codingType), message: err.message });
      }
      this.disableAudio(s, `Audio could not be decoded (${err instanceof Error ? err.message : String(err)}), so playback continues without sound.`);
      return;
    }
    if (chunk.sampleRate !== OUTPUT_SAMPLE_RATE) {
      const factor = chunk.sampleRate / OUTPUT_SAMPLE_RATE;
      if (!s.decimator || s.decimator.factor !== factor) s.decimator = new Decimator(factor);
      chunk = s.decimator.process(chunk);
    }
    writer.enqueue(chunk);
  }

  private isFull(s: Session): boolean {
    // Rendering can be throttled (background tab); drop late frames here so reading never stalls on them.
    if (this.state === 'playing') this.presenter.dropLate(this.clock.nowUs());
    this.audioWriter?.drain();
    return (
      this.videoBlocked(s) ||
      s.pendingVideo.length >= MAX_PENDING_VIDEO ||
      (s.audioActive && (this.audioWriter?.queuedChunks ?? 0) > 0)
    );
  }

  private videoBlocked(s: Session): boolean {
    return this.presenter.size >= MAX_QUEUED_FRAMES || s.decoder.queueSize >= MAX_DECODE_QUEUE;
  }

  private onPipelineEnded(s: Session): void {
    s.eof = true;
    if (s.videoState !== 'configured') {
      s.flushed = true;
      return;
    }
    void s.decoder.flush().then(() => {
      if (this.session === s) s.flushed = true;
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
    this.deps.emit({ type: 'error', code: 'decoder-failed', message: err.message, paths: [] });
    this.pause();
    this.setState('error');
  }

  private updatePlayback(s: Session): void {
    const ring = s.audioActive ? this.ring : null;
    if (this.state === 'buffering' && this.wantPlaying) {
      const audioReady =
        !ring ||
        s.eof ||
        this.videoBlocked(s) ||
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
      return;
    }
    if (!s.eof && ring.buffered() === 0 && !this.videoBlocked(s)) {
      ring.setPlaying(false);
      this.setState('buffering');
    }
  }

  private disableAudio(s: Session, message: string): void {
    if (!s.audioActive) return;
    const now = this.clock.nowUs();
    s.audioActive = false;
    this.ring?.setPlaying(false);
    this.clock.useWall(now, this.state === 'playing');
    this.notice('audio-disabled', message);
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
        corruptPackets: stats.corruptPackets,
        continuityErrors: stats.continuityErrors,
        decoderErrors: this.decoderErrors,
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
    if (err instanceof DiscError) {
      this.deps.emit({ type: 'error', code: err.code, message: err.message, paths: err.paths });
    } else if (err instanceof UnsupportedCodecError) {
      this.deps.emit({ type: 'unsupported', kind: isVideoCoding(err.codingType) ? 'video' : 'audio', codec: codingName(err.codingType), message: err.message });
    } else if (err instanceof ParseError) {
      this.deps.emit({ type: 'error', code: 'corrupt-disc', message: `The disc data is damaged: ${err.message}`, paths: [] });
    } else {
      this.deps.emit({ type: 'error', code: 'internal', message: err instanceof Error ? err.message : String(err), paths: [] });
    }
    this.session?.pipeline.stop();
    this.wantPlaying = false;
    this.ring?.setPlaying(false);
    this.clock.setRunning(false);
    this.setState('error');
  }
}
