export interface AudioClockSource {
  readFrames(): number;
  readonly sampleRate: number;
  latencyUs(): number;
}

export type ClockMode = 'audio' | 'wall';

/** Playlist-time clock driven by audio frames played, or by wall time when there is no audio. */
export class MasterClock {
  private clockMode: ClockMode = 'wall';
  private audio: AudioClockSource | null = null;
  private baseUs = 0;
  private baseFrame = 0;
  private wallStartMs: number | null = null;

  constructor(private readonly nowMs: () => number) {}

  get mode(): ClockMode {
    return this.clockMode;
  }

  useAudio(source: AudioClockSource, baseUs: number): void {
    this.clockMode = 'audio';
    this.audio = source;
    this.baseUs = baseUs;
    this.baseFrame = source.readFrames();
    this.wallStartMs = null;
  }

  useWall(baseUs: number, running: boolean): void {
    this.clockMode = 'wall';
    this.audio = null;
    this.baseUs = baseUs;
    this.wallStartMs = running ? this.nowMs() : null;
  }

  setRunning(running: boolean): void {
    if (this.clockMode !== 'wall') return;
    if (running && this.wallStartMs === null) {
      this.wallStartMs = this.nowMs();
    } else if (!running && this.wallStartMs !== null) {
      this.baseUs = this.nowUs();
      this.wallStartMs = null;
    }
  }

  nowUs(): number {
    if (this.clockMode === 'audio' && this.audio) {
      const playedUs = ((this.audio.readFrames() - this.baseFrame) * 1e6) / this.audio.sampleRate;
      return this.baseUs + Math.max(0, playedUs - this.audio.latencyUs());
    }
    return this.wallStartMs === null ? this.baseUs : this.baseUs + (this.nowMs() - this.wallStartMs) * 1000;
  }
}
