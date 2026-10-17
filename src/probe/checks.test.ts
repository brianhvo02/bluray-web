import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChecks, type ProbeEnv, type ProbeFile, type WorkerInput, type WorkerProbe } from './checks';

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
          if (wrap && a >= 2 ** 32) bytes[4] = 0; // a wrapped read lands elsewhere
          new DataView(bytes.buffer).setFloat64(8, a, true);
          return bytes.buffer;
        },
      };
    },
  };
  return blob as unknown as File;
}

/** A picked file with only the fields the relative-path check reads. */
function pathed(webkitRelativePath: string): File {
  return { name: webkitRelativePath.split('/').pop() ?? '', size: 1, webkitRelativePath } as unknown as File;
}

const okWorker: WorkerProbe = {
  hevc: { hvc1: true, hev1: false, decoded: true },
  raf: { present: true, p95Ms: 16.7 },
  webgl: { float: true, half: true },
};

function env(over: Partial<ProbeEnv> & { files?: File[]; rate?: number } = {}): ProbeEnv {
  return {
    openDisc: over.openDisc ?? (async () => ({ route: 'folder', files: over.files ?? [fakeBigFile('00001.m2ts', 5 * GIB, false)] })),
    createAudioContext: () => ({ sampleRate: over.rate ?? 48000 }) as unknown as BaseAudioContext,
    worker: over.worker ?? (async () => okWorker),
    globals: over.globals ?? {},
  };
}

afterEach(() => vi.useRealTimers());

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

  it('reports no m2ts over 4 GiB as untested and not ok', async () => {
    const r = await find(env({ files: [fakeBigFile('00001.m2ts', GIB, false)] }), 'blob-slice-over-4gib');
    expect(r?.ok).toBe(false);
    expect(r?.detail.startsWith('untested:')).toBe(true);
  });

  it('hevc: hev1-only passes, decode failure and worker error fail, no clip fails', async () => {
    const w = (hevc: WorkerProbe['hevc']) => async (): Promise<WorkerProbe> => ({ ...okWorker, hevc });
    expect(await find(env({ worker: w({ hvc1: false, hev1: true, decoded: true }) }), 'hevc')).toEqual({ name: 'hevc', ok: true, detail: 'hev1' });
    expect(await find(env({ worker: w({ hvc1: true, hev1: true, decoded: false }) }), 'hevc')).toEqual({ name: 'hevc', ok: false, detail: 'hvc1, first GOP did not decode' });
    expect(await find(env({ worker: w({ hvc1: false, hev1: false, decoded: false, error: 'bad sps' }) }), 'hevc')).toEqual({ name: 'hevc', ok: false, detail: 'error: bad sps' });
    expect(await find(env({ worker: w(null) }), 'hevc')).toEqual({ name: 'hevc', ok: false, detail: 'no HEVC clip in the folder' });
  });

  it('relative-path: paths under a disc folder pass and report the first path and empty count', async () => {
    const files = [pathed('disc1/BDMV/index.bdmv'), pathed('disc1/BDMV/PLAYLIST/00000.mpls'), pathed('')];
    expect(await find(env({ files }), 'relative-path')).toEqual({ name: 'relative-path', ok: true, detail: 'disc1/BDMV/index.bdmv — 1/3 empty' });
    const all = [pathed('disc1/BDMV/index.bdmv'), pathed('disc1/BDMV/STREAM/00001.m2ts')];
    expect((await find(env({ files: all }), 'relative-path'))?.detail).toBe('disc1/BDMV/index.bdmv — 0/2 empty');
  });

  it('relative-path: all-empty paths fail with (empty) in the detail', async () => {
    const r = await find(env({ files: [pathed(''), pathed('')] }), 'relative-path');
    expect(r?.ok).toBe(false);
    expect(r?.detail.startsWith('(empty) — ')).toBe(true);
    expect(r?.detail).toBe('(empty) — 2/2 empty');
  });

  it('relative-path: paths rooted at BDMV pass', async () => {
    const r = await find(env({ files: [pathed('BDMV/index.bdmv'), pathed('BDMV/STREAM/00001.m2ts')] }), 'relative-path');
    expect(r).toEqual({ name: 'relative-path', ok: true, detail: 'BDMV/index.bdmv — 0/2 empty' });
  });

  it('passes [path, File] entries to the worker', async () => {
    const file = fakeBigFile('00001.m2ts', 5 * GIB, false);
    let seen: WorkerInput | null = null;
    await runChecks(env({ files: [file], worker: async (input) => { seen = input; return okWorker; } }));
    const entries = seen && 'entries' in seen ? (seen as { entries: ReadonlyArray<readonly [string, File]> }).entries : [];
    expect(entries[0][0]).toBe('disc/BDMV/STREAM/00001.m2ts');
    expect(entries[0][1]).toBe(file);
  });

  it('server route: the slice is a range read, the worker gets the server ref, relative-path is untested', async () => {
    const server = { baseUrl: 'http://127.0.0.1:8080/discs/abc', token: 't' };
    const big = fakeBigFile('00001.M2TS', 5 * GIB, false) as unknown as ProbeFile;
    let seen: WorkerInput | null = null;
    const r = await runChecks(env({ openDisc: async () => ({ route: 'server', files: [big], server }), worker: async (input) => { seen = input; return okWorker; } }));
    expect(r.find((x) => x.name === 'blob-slice-over-4gib')).toMatchObject({ ok: true });
    expect(r.find((x) => x.name === 'blob-slice-over-4gib')?.detail.startsWith('server: offset ')).toBe(true);
    expect(r.find((x) => x.name === 'relative-path')).toMatchObject({ ok: false, detail: 'untested: server route (paths come from the manifest)' });
    expect(seen).toEqual({ server });
  });

  it('worker rows report timed out after 15 s while other rows still run', async () => {
    vi.useFakeTimers();
    const pending = runChecks(env({ worker: () => new Promise<WorkerProbe>(() => undefined) }));
    await vi.advanceTimersByTimeAsync(15000);
    const r = await pending;
    for (const name of ['worker-raf', 'hevc', 'webgl2-float']) expect(r.find((x) => x.name === name)).toMatchObject({ ok: false, detail: 'timed out' });
    expect(r.find((x) => x.name === 'audio-sample-rate')?.ok).toBe(true);
  });
});
