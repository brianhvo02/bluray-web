import { describe, expect, it } from 'vitest';
import { MemoryDirectory } from '../../../tests/helpers/memory-fs';
import { CACHE_DIR, CACHE_MAX_AGE_MS, ReadAheadCache, safeName } from './read-ahead-cache';

const PATH = 'BDMV/STREAM/00001.M2TS';
const bytes = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

function setup(startMs = 1_000_000) {
  const root = new MemoryDirectory();
  const clock = { ms: startMs };
  const deps = { root: async () => root.asHandle(), now: () => clock.ms };
  return { root, clock, deps };
}

describe('ReadAheadCache', () => {
  it('reads back the bytes written, and a range written in pieces', async () => {
    const { deps } = setup();
    const cache = await ReadAheadCache.open('disc-a', deps);
    const data = bytes(3000);
    await cache.write(PATH, 1000, data.subarray(0, 1000));
    await cache.write(PATH, 2000, data.subarray(1000, 3000));
    expect(await cache.read(PATH, 1000, 3000)).toEqual(data);
    expect(await cache.read(PATH, 1500, 100)).toEqual(data.subarray(500, 600));
    expect(await cache.has(PATH, 1000, 3000)).toBe(true);
    cache.close();
  });

  it('answers null unless the whole range is held', async () => {
    const { deps } = setup();
    const cache = await ReadAheadCache.open('disc-a', deps);
    await cache.write(PATH, 0, bytes(100));
    await cache.write(PATH, 200, bytes(100));
    expect(await cache.read(PATH, 50, 100)).toBeNull(); // runs into the gap at 100..200
    expect(await cache.read(PATH, 250, 100)).toBeNull(); // past the end of what is held
    expect(await cache.read('BDMV/STREAM/00002.M2TS', 0, 10)).toBeNull(); // never written
    expect(await cache.has(PATH, 50, 100)).toBe(false);
    cache.close();
  });

  it('keeps what it held for the same disc across opens', async () => {
    const { deps } = setup();
    const first = await ReadAheadCache.open('disc-a', deps);
    await first.write(PATH, 0, bytes(500));
    first.close();
    const again = await ReadAheadCache.open('disc-a', deps);
    await again.clearOthers();
    expect(await again.read(PATH, 0, 500)).toEqual(bytes(500));
    again.close();
  });

  it('clears other discs', async () => {
    const { root, deps } = setup();
    const a = await ReadAheadCache.open('disc-a', deps);
    await a.write(PATH, 0, bytes(500));
    a.close();
    const b = await ReadAheadCache.open('disc-b', deps);
    await b.clearOthers();
    const top = await root.getDirectoryHandle(CACHE_DIR);
    expect([...top.entries.keys()]).toEqual([safeName('disc-b')]);
    b.close();
    const aAgain = await ReadAheadCache.open('disc-a', deps);
    expect(await aAgain.read(PATH, 0, 500)).toBeNull();
    aAgain.close();
  });

  it("clears this disc's bytes once they are over 24 hours old", async () => {
    const { clock, deps } = setup();
    const first = await ReadAheadCache.open('disc-a', deps);
    await first.write(PATH, 0, bytes(500));
    first.close();
    clock.ms += CACHE_MAX_AGE_MS - 1;
    const young = await ReadAheadCache.open('disc-a', deps);
    await young.clearOthers();
    expect(await young.read(PATH, 0, 500)).toEqual(bytes(500));
    young.close();
    clock.ms += 2;
    const old = await ReadAheadCache.open('disc-a', deps);
    await old.clearOthers();
    expect(await old.read(PATH, 0, 500)).toBeNull();
    // what it holds from now on is young again
    await old.write(PATH, 0, bytes(10));
    old.close();
    const next = await ReadAheadCache.open('disc-a', deps);
    await next.clearOthers();
    expect(await next.read(PATH, 0, 10)).toEqual(bytes(10));
    next.close();
  });

  it('clears every disc when a disc not on the NAS opens', async () => {
    const { root, deps } = setup();
    await ReadAheadCache.clearAll(deps.root); // nothing yet
    const a = await ReadAheadCache.open('disc-a', deps);
    await a.write(PATH, 0, bytes(500));
    a.close();
    await ReadAheadCache.clearAll(deps.root);
    expect([...root.entries.keys()]).toEqual([]);
  });

  it('names files safely and distinctly whatever the disc id', () => {
    expect(safeName('a/b')).not.toContain('/');
    expect(safeName('..')).not.toBe('..');
    expect(safeName('a/b')).not.toBe(safeName('a_b'));
    expect(safeName('abc-123')).toBe('abc-123');
  });
});
