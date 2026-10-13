import { describe, expect, it } from 'vitest';
import { loadNodeAudioWasm } from '../../../tests/helpers/audio-wasm';
import { AudioFrameError, WasmCodec, WasmFrameDecoder } from './wasm-audio';

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
