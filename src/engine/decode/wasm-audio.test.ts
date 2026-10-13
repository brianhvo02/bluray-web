import { describe, expect, it } from 'vitest';
import { loadNodeAudioWasm } from '../../../tests/helpers/audio-wasm';
import { AudioFrameError, WasmCodec, WasmFrameDecoder, type AudioWasm } from './wasm-audio';

describe('audio.wasm', () => {
  it('loads and opens and closes both decoders', async () => {
    const wasm = await loadNodeAudioWasm();
    for (const codec of [WasmCodec.AC3, WasmCodec.DTS]) {
      const d = new WasmFrameDecoder(wasm, codec);
      d.reset();
      d.close();
    }
  });

  it('reports a frame that is not audio as an AudioFrameError', async () => {
    const d = new WasmFrameDecoder(await loadNodeAudioWasm(), WasmCodec.AC3);
    expect(() => d.decode(new Uint8Array(256).fill(0x55))).toThrow(AudioFrameError);
    d.close();
  });
});

describe('WasmFrameDecoder allocation failures', () => {
  function fake(mallocs: number[]): { wasm: AudioWasm; calls: string[] } {
    const calls: string[] = [];
    const wasm = {
      memory: new WebAssembly.Memory({ initial: 1 }),
      audio_open: () => 1,
      audio_decode: () => {
        calls.push('decode');
        return 0;
      },
      audio_sample_rate: () => 48000,
      audio_reset: () => undefined,
      audio_close: () => {
        calls.push('close');
      },
      malloc: () => mallocs.shift() ?? 0,
      free: () => undefined,
    } as AudioWasm;
    return { wasm, calls };
  }

  it('closes the decoder when the output buffer cannot be allocated', () => {
    const { wasm, calls } = fake([0]);
    expect(() => new WasmFrameDecoder(wasm, WasmCodec.AC3)).toThrow(/out of memory/);
    expect(calls).toEqual(['close']);
  });

  it('keeps throwing after a failed input allocation instead of decoding from pointer 0', () => {
    const { wasm, calls } = fake([16, 0]);
    const d = new WasmFrameDecoder(wasm, WasmCodec.AC3);
    expect(() => d.decode(new Uint8Array(100))).toThrow(/out of memory/);
    expect(() => d.decode(new Uint8Array(10))).toThrow(/out of memory/);
    expect(calls).not.toContain('decode');
  });
});
