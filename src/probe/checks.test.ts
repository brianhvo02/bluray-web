import { describe, expect, it } from 'vitest';
import { runChecks, type ProbeEnv, type WorkerProbe } from './checks';

const GIB = 2 ** 30;

/** A File-like whose slice(a, b) returns 192 bytes: sync at byte 4 and the offset (as given by `encode`) in the rest. */
function fakeBigFile(name: string, size: number, wrap: boolean): File {
  const blob = {
    size,
    name,
    webkitRelativePath: `disc/BDMV/STREAM/${name}`,
    slice(a: number, b: number) {
      return {
        size: b - a,
        arrayBuffer: async () => {
          const bytes = new Uint8Array(b - a);
          bytes[4] = 0x47;
          const effective = wrap ? a % 2 ** 32 : a;
          // sync is only valid when the offset survived; a wrapped read lands elsewhere
          if (wrap && effective !== a) bytes[4] = 0;
          new DataView(bytes.buffer).setFloat64(8, a, true);
          return bytes.buffer;
        },
      };
    },
  };
  return blob as unknown as File;
}

const okWorker: WorkerProbe = {
  hevc: { hvc1: true, hev1: false, decoded: true },
  raf: { present: true, p95Ms: 16.7 },
  webgl: { float: true, half: true },
};

function env(over: Partial<ProbeEnv> & { files?: File[]; rate?: number } = {}): ProbeEnv {
  return {
    pickFolder: async () => over.files ?? [fakeBigFile('00001.m2ts', 5 * GIB, false)],
    createAudioContext: () => ({ sampleRate: over.rate ?? 48000 }) as unknown as BaseAudioContext,
    worker: over.worker ?? (async () => okWorker),
    globals: over.globals ?? {},
  };
}

const find = async (e: ProbeEnv, name: string) => (await runChecks(e)).find((r) => r.name === name);

describe('runChecks', () => {
  it('blob-slice-over-4gib passes when the offset above 2^32 is read faithfully', async () => {
    const r = await find(env(), 'blob-slice-over-4gib');
    expect(r?.ok).toBe(true);
    expect(Number(/\d+/.exec(r?.detail ?? '')?.[0])).toBeGreaterThanOrEqual(4294967296);
  });

  it('blob-slice-over-4gib fails when the offset wraps at 2^32', async () => {
    const r = await find(env({ files: [fakeBigFile('00001.m2ts', 5 * GIB, true)] }), 'blob-slice-over-4gib');
    expect(r?.ok).toBe(false);
  });

  it('reports audio sample rate', async () => {
    expect(await find(env({ rate: 44100 }), 'audio-sample-rate')).toEqual({ name: 'audio-sample-rate', ok: false, detail: '44100' });
    expect((await find(env({ rate: 48000 }), 'audio-sample-rate'))?.ok).toBe(true);
  });

  it('reports hevc support from the worker', async () => {
    expect(await find(env(), 'hevc')).toEqual({ name: 'hevc', ok: true, detail: 'hvc1' });
  });

  it('keeps going when a check throws', async () => {
    const r = await runChecks(env({ worker: async () => { throw new Error('boom'); } }));
    expect(r.find((x) => x.name === 'hevc')?.ok).toBe(false);
    expect(r.find((x) => x.name === 'audio-sample-rate')?.ok).toBe(true);
  });
});
