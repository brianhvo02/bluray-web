import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadNodeAudioWasm } from '../../../tests/helpers/audio-wasm';
import { lpcmPayload } from '../../../tests/helpers/synthetic-disc';
import { CodingType } from '../bdmv/stream-types';
import { createAudioDecoderFactory } from './audio-decoder';
import { UnsupportedCodecError } from './decoder';

const AC3 = readFileSync(fileURLToPath(new URL('../../../fixtures/synthetic/audio/tone-ac3-stereo.ac3', import.meta.url)));

describe('createAudioDecoderFactory', () => {
  it('decodes LPCM without loading the WASM and counts a corrupt unit as one failed frame', async () => {
    let loads = 0;
    const factory = createAudioDecoderFactory(() => {
      loads++;
      return loadNodeAudioWasm();
    });
    const d = await factory(CodingType.LPCM);
    const ok = d.decode({ data: lpcmPayload(240, 0), ptsUs: 5_000 });
    expect(ok.failedFrames).toBe(0);
    expect(ok.chunks.map((c) => [c.ptsUs, c.frames, c.sampleRate])).toEqual([[5_000, 240, 48_000]]);
    const bad = lpcmPayload(240, 0);
    bad[2] = 0x30; // reserved sample-rate code
    expect(d.decode({ data: bad, ptsUs: 0 })).toEqual({ chunks: [], failedFrames: 1 });
    expect(loads).toBe(0);
  });

  it('decodes AC-3 through the WASM and loads it once for several decoders', async () => {
    let loads = 0;
    const factory = createAudioDecoderFactory(() => {
      loads++;
      return loadNodeAudioWasm();
    });
    const d = await factory(CodingType.AC3);
    await factory(CodingType.DTS);
    const r = d.decode({ data: AC3.subarray(0, 3 * 768), ptsUs: 1_000_000 }); // 192 kb/s → 768-byte frames
    expect(r.failedFrames).toBe(0);
    expect(r.chunks.map((c) => [c.ptsUs, c.frames])).toEqual([
      [1_000_000, 1536],
      [1_032_000, 1536],
      [1_064_000, 1536],
    ]);
    expect(loads).toBe(1);
    d.close();
  });

  it('plays only the AC-3 core of a TrueHD stream', async () => {
    const d = await createAudioDecoderFactory(loadNodeAudioWasm)(CodingType.TRUEHD);
    expect(d.decode({ data: new Uint8Array(400).fill(0xf8), ptsUs: 0, streamIdExtension: 0x72 })).toEqual({ chunks: [], failedFrames: 0 });
    const r = d.decode({ data: AC3.subarray(0, 768), ptsUs: 0, streamIdExtension: 0x76 });
    expect(r.chunks).toHaveLength(1);
    d.close();
  });

  it('retries a failed WASM load on the next request', async () => {
    let calls = 0;
    const factory = createAudioDecoderFactory(() => (++calls === 1 ? Promise.reject(new Error('offline')) : loadNodeAudioWasm()));
    await expect(factory(CodingType.AC3)).rejects.toThrow('offline');
    await expect(factory(CodingType.AC3)).resolves.toBeDefined();
  });

  it('rejects secondary audio as unsupported', async () => {
    await expect(createAudioDecoderFactory(loadNodeAudioWasm)(CodingType.EAC3_SECONDARY)).rejects.toBeInstanceOf(UnsupportedCodecError);
  });
});
