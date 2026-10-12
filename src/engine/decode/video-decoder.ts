import { CodingType, codingName } from '../bdmv/stream-types';
import { DecoderError, UnsupportedCodecError, type Decoder, type StreamConfig } from './decoder';
import { analyzeAvc, avcCodecString, type AccessUnitInfo } from './h264';
import { analyzeHevc, hevcCodecString } from './hevc';

export interface VideoUnit {
  readonly data: Uint8Array;
  readonly ptsUs: number;
  /** Decode for reference but never present (e.g. before a seek target or outside the play item). */
  readonly discard: boolean;
}

export interface VideoDecoderLike {
  readonly state: CodecState;
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

export interface VideoCodecApi {
  create(init: VideoDecoderInit): VideoDecoderLike;
  isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport>;
  makeChunk(init: EncodedVideoChunkInit): EncodedVideoChunk;
}

export const browserVideoCodecApi: VideoCodecApi = {
  create: (init) => new VideoDecoder(init),
  isConfigSupported: (config) => VideoDecoder.isConfigSupported(config),
  makeChunk: (init) => new EncodedVideoChunk(init),
};

interface CodecOps {
  analyze(data: Uint8Array): AccessUnitInfo;
  codecString(sps: Uint8Array): string;
}

const CODECS: ReadonlyMap<number, CodecOps> = new Map<number, CodecOps>([
  [CodingType.AVC, { analyze: analyzeAvc, codecString: avcCodecString }],
  [CodingType.HEVC, { analyze: analyzeHevc, codecString: hevcCodecString }],
]);

const MAX_CONSECUTIVE_ERRORS = 3;

export function hasSps(codingType: number, data: Uint8Array): boolean {
  return (CODECS.get(codingType)?.analyze(data).sps ?? null) !== null;
}

export class WebCodecsVideoDecoder implements Decoder<VideoUnit, VideoFrame> {
  onOutput: (frame: VideoFrame) => void = () => undefined;
  onError: (err: DecoderError) => void = () => undefined;

  private decoder: VideoDecoderLike | null = null;
  private config: VideoDecoderConfig | null = null;
  private ops: CodecOps | null = null;
  private needKey = true;
  private requireIdr = false;
  private lastKeyWasIdr = true;
  private consecutiveErrors = 0;
  private readonly discard = new Set<number>();

  constructor(private readonly api: VideoCodecApi = browserVideoCodecApi) {}

  get queueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  get codec(): string | null {
    return this.config?.codec ?? null;
  }

  async configure(config: StreamConfig): Promise<void> {
    const ops = CODECS.get(config.codingType);
    if (!ops) throw new UnsupportedCodecError(config.codingType, `${codingName(config.codingType)} video is not supported.`);
    if (!config.firstUnit) throw new Error('video configure() needs the first access unit');
    const info = ops.analyze(config.firstUnit);
    if (!info.sps) throw new Error('first video access unit has no SPS');
    const vdc: VideoDecoderConfig = { codec: ops.codecString(info.sps) };
    const support = await this.api.isConfigSupported(vdc);
    if (!support.supported) {
      throw new UnsupportedCodecError(config.codingType, `This browser cannot decode ${codingName(config.codingType)} (${vdc.codec}).`);
    }
    this.ops = ops;
    this.config = vdc;
    this.open();
  }

  decode(unit: VideoUnit): void {
    const decoder = this.decoder;
    const ops = this.ops;
    if (!decoder || !ops || decoder.state !== 'configured') return;
    const info = ops.analyze(unit.data);
    const startsSequence = this.needKey;
    if (startsSequence) {
      if (!info.key || (this.requireIdr && !info.idr)) return;
      this.needKey = false;
      this.lastKeyWasIdr = info.idr;
    }
    if (unit.discard) this.discard.add(unit.ptsUs);
    decoder.decode(this.api.makeChunk({ type: startsSequence || info.idr ? 'key' : 'delta', timestamp: unit.ptsUs, data: info.data }));
  }

  async flush(): Promise<void> {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== 'configured') return;
    try {
      await decoder.flush();
    } catch {
      return; // a reset() during flush aborts it; nothing to do
    }
    this.needKey = true;
  }

  reset(): void {
    this.discard.clear();
    this.needKey = true;
    const decoder = this.decoder;
    if (!decoder || !this.config) return;
    if (decoder.state === 'closed') {
      this.open();
      return;
    }
    decoder.reset();
    decoder.configure(this.config);
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.discard.clear();
  }

  private open(): void {
    const config = this.config;
    if (!config) return;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    const decoder = this.api.create({
      output: (frame) => this.handleFrame(decoder, frame),
      error: (err) => this.handleError(decoder, err),
    });
    decoder.configure(config);
    this.decoder = decoder;
    this.needKey = true;
    this.discard.clear();
  }

  private handleFrame(source: VideoDecoderLike, frame: VideoFrame): void {
    if (source !== this.decoder) {
      frame.close();
      return;
    }
    this.consecutiveErrors = 0;
    if (this.discard.delete(frame.timestamp)) {
      frame.close();
      return;
    }
    this.onOutput(frame);
  }

  private handleError(source: VideoDecoderLike, err: DOMException): void {
    if (source !== this.decoder) return;
    this.consecutiveErrors++;
    if (!this.lastKeyWasIdr) this.requireIdr = true;
    if (this.consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
      this.decoder = null;
      this.onError(new DecoderError(`Video decoding failed: ${err.message}`, true));
      return;
    }
    this.open();
    this.onError(new DecoderError(`Video decoder error, recovering at the next keyframe: ${err.message}`, false));
  }
}
