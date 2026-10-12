import { describe, expect, it } from 'vitest';
import { avcAu } from '../../../tests/helpers/h264-units';
import { CodingType } from '../bdmv/stream-types';
import { DecoderError, UnsupportedCodecError } from './decoder';
import { WebCodecsVideoDecoder, type VideoCodecApi, type VideoDecoderLike } from './video-decoder';

interface FakeFrame {
  timestamp: number;
  closed: boolean;
  close(): void;
}

class FakeDecoder implements VideoDecoderLike {
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  config: VideoDecoderConfig | null = null;
  readonly chunks: EncodedVideoChunkInit[] = [];
  readonly frames: FakeFrame[] = [];

  constructor(private readonly init: VideoDecoderInit) {}

  configure(config: VideoDecoderConfig): void {
    this.config = config;
    this.state = 'configured';
  }

  decode(chunk: EncodedVideoChunk): void {
    const init = chunk as unknown as EncodedVideoChunkInit;
    this.chunks.push(init);
    const frame: FakeFrame = { timestamp: init.timestamp, closed: false, close() { this.closed = true; } };
    this.frames.push(frame);
    this.init.output(frame as unknown as VideoFrame);
  }

  async flush(): Promise<void> {}

  reset(): void {
    this.state = 'unconfigured';
  }

  close(): void {
    this.state = 'closed';
  }

  fail(message: string): void {
    this.state = 'closed';
    this.init.error(new DOMException(message, 'EncodingError'));
  }
}

function setup(supported = true): { api: VideoCodecApi; created: FakeDecoder[]; checked: VideoDecoderConfig[] } {
  const created: FakeDecoder[] = [];
  const checked: VideoDecoderConfig[] = [];
  const api: VideoCodecApi = {
    create: (init) => {
      const d = new FakeDecoder(init);
      created.push(d);
      return d;
    },
    isConfigSupported: async (config) => {
      checked.push(config);
      return { supported, config };
    },
    makeChunk: (init) => init as unknown as EncodedVideoChunk,
  };
  return { api, created, checked };
}

async function configured(): Promise<{ dec: WebCodecsVideoDecoder; created: FakeDecoder[]; out: VideoFrame[]; errors: DecoderError[] }> {
  const { api, created } = setup();
  const dec = new WebCodecsVideoDecoder(api);
  const out: VideoFrame[] = [];
  const errors: DecoderError[] = [];
  dec.onOutput = (f) => out.push(f);
  dec.onError = (e) => errors.push(e);
  await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
  return { dec, created, out, errors };
}

describe('WebCodecsVideoDecoder', () => {
  it('configures AVC with a codec string from the SPS', async () => {
    const { api, created, checked } = setup();
    const dec = new WebCodecsVideoDecoder(api);
    await dec.configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) });
    expect(checked).toEqual([{ codec: 'avc1.640028' }]);
    expect(created[0].config?.codec).toBe('avc1.640028');
    expect(dec.codec).toBe('avc1.640028');
  });

  it('rejects unsupported codecs', async () => {
    const { api } = setup();
    await expect(new WebCodecsVideoDecoder(api).configure({ codingType: CodingType.VC1, firstUnit: avcAu({ idr: true }) })).rejects.toBeInstanceOf(UnsupportedCodecError);
    const unsupported = setup(false);
    await expect(new WebCodecsVideoDecoder(unsupported.api).configure({ codingType: CodingType.AVC, firstUnit: avcAu({ idr: true }) })).rejects.toBeInstanceOf(UnsupportedCodecError);
  });

  it('skips delta units until a key unit, then marks only the first as key', async () => {
    const { dec, created, out } = await configured();
    dec.decode({ data: avcAu(), ptsUs: 0, discard: false });
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 41_708, discard: false });
    dec.decode({ data: avcAu(), ptsUs: 83_416, discard: false });
    expect(created[0].chunks.map((c) => [c.type, c.timestamp])).toEqual([
      ['key', 41_708],
      ['delta', 83_416],
    ]);
    expect(out.map((f) => f.timestamp)).toEqual([41_708, 83_416]);
  });

  it('closes frames of discarded units instead of outputting them', async () => {
    const { dec, created, out } = await configured();
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: true });
    dec.decode({ data: avcAu(), ptsUs: 41_708, discard: false });
    expect(out.map((f) => f.timestamp)).toEqual([41_708]);
    expect(created[0].frames[0].closed).toBe(true);
  });

  it('after an error following a recovery-point start, waits for an IDR', async () => {
    const { dec, created, errors } = await configured();
    dec.decode({ data: avcAu({ recovery: true, sps: true }), ptsUs: 0, discard: false });
    created[0].fail('bad keyframe');
    expect(errors.map((e) => e.fatal)).toEqual([false]);
    expect(created).toHaveLength(2);
    dec.decode({ data: avcAu({ recovery: true, sps: true }), ptsUs: 41_708, discard: false });
    expect(created[1].chunks).toHaveLength(0);
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 83_416, discard: false });
    expect(created[1].chunks.map((c) => c.type)).toEqual(['key']);
  });

  it('gives up with a fatal error after repeated failures without output', async () => {
    const { dec, created, errors } = await configured();
    for (let i = 0; i < 4; i++) created[created.length - 1].fail(`boom ${i}`);
    expect(errors.map((e) => e.fatal)).toEqual([false, false, false, true]);
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false }); // no-op once fatal
  });

  it('reset requires a key unit again and forgets discards', async () => {
    const { dec, created, out } = await configured();
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 0, discard: false });
    dec.reset();
    expect(created[0].state).toBe('configured');
    dec.decode({ data: avcAu(), ptsUs: 41_708, discard: false });
    dec.decode({ data: avcAu({ idr: true }), ptsUs: 83_416, discard: false });
    expect(out.map((f) => f.timestamp)).toEqual([0, 83_416]);
  });
});
