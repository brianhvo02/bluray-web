import { renderQuantum, ringViews, type RingViews } from '../engine/audio/ring';

interface PcmPlayerOptions {
  processorOptions: { ring: SharedArrayBuffer };
}

// AudioWorkletGlobalScope globals (not in lib.dom).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processorCtor: new (options: PcmPlayerOptions) => AudioWorkletProcessor): void;

class PcmPlayer extends AudioWorkletProcessor {
  private readonly views: RingViews;

  constructor(options: PcmPlayerOptions) {
    super();
    this.views = ringViews(options.processorOptions.ring);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0];
    renderQuantum(this.views, left, right);
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
