import { Control, OUTPUT_SAMPLE_RATE, createRing, ringViews } from '../engine/audio/ring';
import type { AudioOutputLike } from './player-controller';
import workletUrl from './pcm-worklet.ts?worker&url';

const RING_SECONDS = 2;

/** 48 kHz stereo AudioContext playing from the shared ring through a gain node. */
export class AudioOutput implements AudioOutputLike {
  private started: { context: AudioContext; ready: Promise<SharedArrayBuffer> } | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private muted = false;

  ensureStarted(): Promise<SharedArrayBuffer> {
    let attempt = this.started;
    if (!attempt) {
      const context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE, latencyHint: 'playback' });
      const created = { context, ready: this.setUp(context) };
      attempt = created;
      this.started = created;
      // A failed start must not stay cached: close the context and let the next user gesture retry.
      created.ready.catch(() => {
        context.close().catch(() => undefined); // already closed: nothing to release
        if (this.started === created) this.started = null;
      });
    }
    void attempt.context.resume();
    return attempt.ready;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  private async setUp(context: AudioContext): Promise<SharedArrayBuffer> {
    await context.audioWorklet.addModule(workletUrl);
    const ring = createRing(OUTPUT_SAMPLE_RATE, RING_SECONDS);
    const node = new AudioWorkletNode(context, 'pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ring },
    });
    const gain = context.createGain();
    node.connect(gain).connect(context.destination);
    this.gain = gain;
    this.applyGain();
    const views = ringViews(ring);
    const publishLatency = (): void => {
      const seconds = (context.outputLatency || 0) + context.baseLatency;
      Atomics.store(views.control, Control.LatencyUs, Math.round(seconds * 1e6));
    };
    publishLatency();
    setInterval(publishLatency, 500);
    return ring;
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }
}
