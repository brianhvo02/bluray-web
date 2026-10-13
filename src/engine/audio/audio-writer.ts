import type { PcmChunk } from '../decode/lpcm';
import type { RingWriter } from './ring';

/** Places decoded PCM into the ring at the frame position implied by its PTS. */
export class AudioWriter {
  private baseUs = 0;
  private baseFrame = 0;
  /** Frame just after the last chunk written; chunks landing within one frame of it are butted against it. */
  private nextFrame: number | null = null;
  private readonly queue: PcmChunk[] = [];

  constructor(private readonly ring: RingWriter) {}

  /** Call after a discard: media time `baseUs` maps to the current read head. */
  start(baseUs: number): void {
    this.baseUs = baseUs;
    this.baseFrame = this.ring.readFrames();
    this.queue.length = 0;
    this.nextFrame = null;
  }

  get queuedChunks(): number {
    return this.queue.length;
  }

  frameAt(us: number): number {
    return this.baseFrame + Math.round(((us - this.baseUs) * this.ring.sampleRate) / 1e6);
  }

  enqueue(chunk: PcmChunk): void {
    if (chunk.sampleRate !== this.ring.sampleRate) {
      throw new Error(`chunk sample rate ${chunk.sampleRate} does not match output ${this.ring.sampleRate}`);
    }
    this.queue.push(chunk);
    this.drain();
  }

  drain(): void {
    while (this.queue.length > 0) {
      const chunk = this.queue[0];
      let at = this.frameAt(chunk.ptsUs);
      if (this.nextFrame !== null && Math.abs(at - this.nextFrame) <= 1) at = this.nextFrame; // rounding, not a real gap
      if (!this.ring.writeAt(at, chunk.stereo.subarray(0, chunk.frames * 2))) return;
      this.nextFrame = at + chunk.frames;
      this.queue.shift();
    }
  }
}
