import type { PcmChunk } from '../decode/lpcm';
import type { RingWriter } from './ring';

/** Places decoded PCM into the ring at the frame position implied by its PTS. */
export class AudioWriter {
  private baseUs = 0;
  private baseFrame = 0;
  private readonly queue: PcmChunk[] = [];

  constructor(private readonly ring: RingWriter) {}

  /** Call after a discard: media time `baseUs` maps to the current read head. */
  start(baseUs: number): void {
    this.baseUs = baseUs;
    this.baseFrame = this.ring.readFrames();
    this.queue.length = 0;
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
      if (!this.ring.writeAt(this.frameAt(chunk.ptsUs), chunk.stereo.subarray(0, chunk.frames * 2))) return;
      this.queue.shift();
    }
  }
}
