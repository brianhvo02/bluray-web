import type { PlaylistSummary } from '../engine/disc/open-disc';
import type { Chapter } from '../engine/nav/timeline';
import type { AudioTrack, EngineCommand, EngineEvent, ErrorCode, MenuKey, PlaybackState, Telemetry } from '../engine/protocol';
import { trackLabel } from './language';

export interface Notice {
  readonly code: string;
  readonly message: string;
}

export interface PlayerSnapshot {
  readonly engineState: PlaybackState;
  readonly playlists: readonly PlaylistSummary[];
  readonly usesBdj: boolean;
  readonly warnings: readonly string[];
  readonly currentPlaylistId: string | null;
  readonly durationUs: number;
  readonly timeUs: number;
  readonly chapters: readonly Chapter[];
  readonly notices: readonly Notice[];
  readonly error: { readonly code: ErrorCode; readonly message: string; readonly paths: readonly string[] } | null;
  readonly telemetry: Telemetry | null;
  readonly volume: number;
  readonly muted: boolean;
  readonly audioTracks: readonly AudioTrack[];
  readonly selectedAudio: number | null;
  /** A disc menu is shown (arrows, Enter, digits and the pointer go to it). */
  readonly menuActive: boolean;
  readonly popupAvailable: boolean;
  /** The menu button under the pointer, after the last pointer move. */
  readonly pointerButton: number | null;
}

export const INITIAL_SNAPSHOT: PlayerSnapshot = {
  engineState: 'idle',
  playlists: [],
  usesBdj: false,
  warnings: [],
  currentPlaylistId: null,
  durationUs: 0,
  timeUs: 0,
  chapters: [],
  notices: [],
  error: null,
  telemetry: null,
  volume: 1,
  muted: false,
  audioTracks: [],
  selectedAudio: null,
  menuActive: false,
  popupAvailable: false,
  pointerButton: null,
};

function withNotice(s: PlayerSnapshot, notice: Notice): PlayerSnapshot {
  return { ...s, notices: [...s.notices.filter((n) => n.code !== notice.code), notice] };
}

export function reduceEvent(s: PlayerSnapshot, e: EngineEvent): PlayerSnapshot {
  switch (e.type) {
    case 'titles':
      return { ...s, playlists: e.playlists, usesBdj: e.usesBdj, warnings: e.warnings, error: null, currentPlaylistId: null, chapters: [], durationUs: 0, timeUs: 0, audioTracks: [], selectedAudio: null };
    case 'chapters':
      // Notices are not cleared here: the engine emits a playlist's own notices before this event.
      return { ...s, currentPlaylistId: e.playlistId, durationUs: e.durationUs, chapters: e.chapters, timeUs: 0, error: null };
    case 'tracks':
      return { ...s, audioTracks: e.audio, selectedAudio: e.selectedAudio };
    case 'state':
      return { ...s, engineState: e.state };
    case 'time':
      return { ...s, timeUs: e.timeUs };
    case 'notice':
      return withNotice(s, { code: e.code, message: e.message });
    case 'unsupported':
      return withNotice(s, { code: `unsupported-${e.kind}`, message: e.message });
    case 'error':
      return { ...s, error: { code: e.code, message: e.message, paths: e.paths } };
    case 'telemetry':
      return { ...s, telemetry: e.telemetry };
    case 'menuActive':
      return { ...s, menuActive: e.active, popupAvailable: e.popupAvailable, pointerButton: e.active ? s.pointerButton : null };
    case 'pointerTarget':
      return { ...s, pointerButton: e.button };
    case 'indexTitles':
    case 'uoMask':
      return s; // consumed by the menu UI in a later task
    case 'playlistCleared':
      return { ...s, currentPlaylistId: null, durationUs: 0, chapters: [], timeUs: 0, audioTracks: [], selectedAudio: null };
  }
}

export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
}

export interface AudioOutputLike {
  ensureStarted(): Promise<SharedArrayBuffer>;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
}

/** Main-thread facade over the engine worker; an external store for React. */
export class PlayerController {
  private snapshot: PlayerSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private audioAttached = false;
  private readonly transferredCanvases = new WeakSet<HTMLCanvasElement>();

  constructor(
    private readonly worker: WorkerLike,
    private readonly audio: AudioOutputLike,
  ) {
    worker.onmessage = (event: MessageEvent<EngineEvent>) => this.update(reduceEvent(this.snapshot, event.data));
    worker.onerror = (event) => this.reportInternalError(`The player engine stopped unexpectedly: ${event.message || 'unknown error'}`);
    worker.onmessageerror = () => this.reportInternalError('The player engine sent a message that could not be read.');
  }

  /** Surfaces a failure of the engine worker itself (it can no longer report through events). */
  reportInternalError(message: string): void {
    const s = reduceEvent(this.snapshot, { type: 'error', code: 'internal', message, paths: [] });
    this.update({ ...s, engineState: 'error' }); // the engine can't report its own state any more
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PlayerSnapshot => this.snapshot;

  /** Each canvas can be transferred only once (React StrictMode runs effects twice); a remounted screen brings a new one. */
  attachCanvas(canvas: HTMLCanvasElement): void {
    if (this.transferredCanvases.has(canvas)) return;
    this.transferredCanvases.add(canvas);
    const offscreen = canvas.transferControlToOffscreen();
    this.post({ type: 'attachCanvas', canvas: offscreen }, [offscreen]);
  }

  resize(width: number, height: number): void {
    this.post({ type: 'resize', width, height });
  }

  /** Call from user-gesture handlers so the AudioContext is allowed to start. */
  startAudio(): void {
    this.audio.ensureStarted().then(
      (ring) => {
        if (this.audioAttached) return;
        this.audioAttached = true;
        this.post({ type: 'attachAudio', ring });
      },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.update(withNotice(this.snapshot, { code: 'audio-output', message: `Audio output could not start: ${reason}` }));
      },
    );
  }

  open(entries: ReadonlyArray<readonly [string, File]>): void {
    this.startAudio();
    this.update({ ...INITIAL_SNAPSHOT, volume: this.snapshot.volume, muted: this.snapshot.muted, engineState: 'loading' });
    this.post({ type: 'open', entries });
  }

  playPlaylist(playlistId: string): void {
    this.startAudio();
    // Drop the previous playlist's notices now; the engine handles commands in order, so every notice
    // it emits for the new playlist arrives after this. Disc-level (bdj) and device-level (audio-output) notices stay.
    const playlistScoped = (code: string): boolean =>
      code.startsWith('unsupported-') || code === 'audio-disabled' || code === 'decoder-recovered' || code === 'audio-track';
    this.update({ ...this.snapshot, notices: this.snapshot.notices.filter((n) => !playlistScoped(n.code)) });
    this.post({ type: 'playPlaylist', playlistId });
  }

  play(): void {
    this.startAudio();
    this.post({ type: 'play' });
  }

  pause(): void {
    this.post({ type: 'pause' });
  }

  togglePlay(): void {
    const state = this.snapshot.engineState;
    if (state === 'playing' || state === 'buffering') this.pause();
    else this.play();
  }

  seek(timeUs: number): void {
    this.post({ type: 'seek', timeUs: Math.min(Math.max(0, timeUs), this.snapshot.durationUs) });
  }

  seekBy(deltaUs: number): void {
    this.seek(this.snapshot.timeUs + deltaUs);
  }

  nextChapter(): void {
    this.post({ type: 'nextChapter' });
  }

  prevChapter(): void {
    this.post({ type: 'prevChapter' });
  }

  setVolume(volume: number): void {
    const v = Math.min(Math.max(0, volume), 1);
    this.audio.setVolume(v);
    this.update({ ...this.snapshot, volume: v });
  }

  /** Volume keys: change the level and unmute, so the change is audible. */
  adjustVolume(delta: number): void {
    if (this.snapshot.muted) this.toggleMute();
    this.setVolume(this.snapshot.volume + delta);
  }

  toggleMute(): void {
    const muted = !this.snapshot.muted;
    this.audio.setMuted(muted);
    this.update({ ...this.snapshot, muted });
  }

  selectAudio(index: number): void {
    const track = this.snapshot.audioTracks.find((t) => t.index === index);
    if (!track?.playable || index === this.snapshot.selectedAudio) return;
    this.post({ type: 'selectAudio', index });
    // Shown at once so the next A press moves on; the engine's `tracks` event corrects it if the switch is refused.
    const selected = { ...this.snapshot, selectedAudio: index };
    this.update(withNotice(selected, { code: 'audio-track', message: `Audio: ${trackLabel(track)}` }));
  }

  /** The A key: the next playable track, wrapping around. */
  cycleAudio(): void {
    const playable = this.snapshot.audioTracks.filter((t) => t.playable);
    if (playable.length < 2) return;
    const at = playable.findIndex((t) => t.index === this.snapshot.selectedAudio);
    this.selectAudio(playable[(at + 1) % playable.length].index);
  }

  menuKey(key: MenuKey): void {
    this.post({ type: 'menuKey', key });
  }

  /** (x, y) in the 1920×1080 menu space. */
  pointer(kind: 'move' | 'click', x: number, y: number): void {
    this.post({ type: 'pointer', kind, x, y });
  }

  dismissNotice(code: string): void {
    this.update({ ...this.snapshot, notices: this.snapshot.notices.filter((n) => n.code !== code) });
  }

  closeDisc(): void {
    this.post({ type: 'close' });
    this.update({ ...INITIAL_SNAPSHOT, volume: this.snapshot.volume, muted: this.snapshot.muted });
  }

  private post(cmd: EngineCommand, transfer: Transferable[] = []): void {
    this.worker.postMessage(cmd, transfer);
  }

  private update(next: PlayerSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
