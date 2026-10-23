import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { bundledAnime4k } from './bundled-shaders';
import { parseInputConf } from './shader-sets';

const SHADERS = 'src/ui/anime4k/shaders';
const confNames = (): Set<string> =>
  new Set(['input-hq.conf', 'input-fast.conf'].flatMap((f) => parseInputConf(readFileSync(`src/ui/anime4k/${f}`, 'utf8')).flatMap((s) => s.files)));

describe('bundledAnime4k', () => {
  it('every file named in input-hq.conf and input-fast.conf is bundled', () => {
    const named = confNames();
    expect(named.size).toBe(14);
    const onDisk = new Set(readdirSync(SHADERS).filter((f) => f.endsWith('.glsl')));
    expect([...named].filter((n) => !onDisk.has(n))).toEqual([]);
    expect([...bundledAnime4k().names].sort()).toEqual([...named].sort());
  });

  it('loads a file by name from its asset URL', async () => {
    const fetchFn = vi.fn(async (url: string) => new Response(`text of ${url}`));
    const bundled = bundledAnime4k(fetchFn);
    const text = await bundled.load('Anime4K_Clamp_Highlights.glsl');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toMatch(/Anime4K_Clamp_Highlights.*\.glsl/);
    expect(text).toMatch(/^text of /);
  });

  it('rejects an unknown name and a failed response', async () => {
    const bundled = bundledAnime4k(async () => new Response('gone', { status: 404 }));
    await expect(bundled.load('nope.glsl')).rejects.toThrow(/not bundled/);
    await expect(bundled.load('Anime4K_Clamp_Highlights.glsl')).rejects.toThrow(/404/);
  });

  it('gives up on a fetch that never answers, so the shader queue is freed', async () => {
    const clock = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(clock.signal);
    try {
      const fetchFn = (_url: string, signal?: AbortSignal): Promise<Response> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        });
      const result = bundledAnime4k(fetchFn).load('Anime4K_Clamp_Highlights.glsl');
      expect(timeout).toHaveBeenCalledWith(15_000);
      clock.abort(new Error('timed out'));
      await expect(result).rejects.toThrow(/timed out/);
    } finally {
      timeout.mockRestore();
    }
  });
});
