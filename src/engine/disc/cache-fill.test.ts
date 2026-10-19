import { describe, expect, it } from 'vitest';
import { fakeNas } from '../../../tests/helpers/fake-nas';
import { MemoryDirectory } from '../../../tests/helpers/memory-fs';
import { CacheFill, FILL_GIVE_UP_MS, type FillProgress } from './cache-fill';
import { createByteSource } from './disc-spec';
import { RemoteDiscError } from './http-transport';
import { ReadAheadCache } from './read-ahead-cache';
import { RemoteSource } from './remote-source';

const CHUNK = 1024;
const PATH = 'BDMV/STREAM/00001.M2TS';
const SIZE = 8 * CHUNK;

/**
 * A fill over a real RemoteSource (HttpTransport over a fake NAS fetch) into a real cache on the memory file system,
 * with a manual clock and timers. `failing(from)` decides whether a read fails: 'lost' as the network failing (a
 * TypeError, which the transport reports as nas-lost), 'changed' as the NAS saying the disc changed.
 */
async function setup(failing: (from: number, attempt: number) => 'lost' | 'changed' | null) {
  const stream = Uint8Array.from({ length: SIZE }, (_, i) => i & 0xff);
  const nas = fakeNas(new Map([[PATH, stream]]));
  const attempts = new Map<number, number>();
  const reads: number[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const from = Number(/^bytes=(\d+)-/.exec(new Headers(init?.headers).get('Range') ?? '')?.[1] ?? 0);
    const attempt = (attempts.get(from) ?? 0) + 1;
    attempts.set(from, attempt);
    reads.push(from);
    const outcome = failing(from, attempt);
    if (outcome === 'lost') throw new TypeError('Failed to fetch');
    if (outcome === 'changed') return Response.json({ error: 'disc-changed' }, { status: 404 });
    return nas.fetch(input, init);
  }) as typeof globalThis.fetch;
  const remote = createByteSource(nas.spec, { fetch, readAheadBytes: 2 * CHUNK, chunkBytes: CHUNK, onWaiting: () => undefined }) as RemoteSource;
  const root = new MemoryDirectory();
  const cache = await ReadAheadCache.open('d1', { root: async () => root.asHandle(), now: () => 0, fileSize: (p) => (p === PATH ? SIZE : undefined) });
  remote.setCache(cache);
  const clock = { ms: 0 };
  const timers: Array<{ at: number; fn: () => void; ms: number }> = [];
  const progress: FillProgress[] = [];
  const fill = new CacheFill({
    remote,
    cache,
    ranges: () => [{ path: PATH, start: 0, end: SIZE }],
    follow: true,
    targetBytes: SIZE,
    progress: (p) => progress.push(p),
    nowMs: () => clock.ms,
    setTimer: (ms, fn) => {
      const t = { at: clock.ms + ms, fn, ms };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
    permanent: (err) => err instanceof RemoteDiscError && (err.reason === 'disc-changed' || err.reason === 'nas-unpaired'),
  });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  /** Moves the clock to the next timer and runs it. */
  const nextTimer = async () => {
    await settle();
    const t = timers.shift();
    if (!t) throw new Error('no timer');
    clock.ms = t.at;
    t.fn();
    await settle();
    return t.ms;
  };
  void fill.run();
  return { fill, cache, reads, progress, timers, nextTimer, settle, clock };
}

describe('CacheFill retries', () => {
  it('retries a read that fails twice, after 1 s then 2 s, and resumes where it stopped', async () => {
    // the third chunk fails twice (the link flaps), then the reconnect brings it
    const t = await setup((from, attempt) => (from === 2 * CHUNK && attempt <= 2 ? 'lost' : null));
    await t.settle();
    expect(t.cache.has(PATH, 0, 2 * CHUNK)).toBe(true);
    expect(t.cache.has(PATH, 2 * CHUNK, CHUNK)).toBe(false);
    expect(await t.nextTimer()).toBe(1_000);
    expect(await t.nextTimer()).toBe(2_000);
    await t.settle();
    expect(t.cache.has(PATH, 0, SIZE)).toBe(true);
    expect(t.reads.filter((r) => r === 2 * CHUNK)).toHaveLength(3);
    // after the failed chunk, the fill went on from it, not from the start
    const firstRetry = t.reads.indexOf(2 * CHUNK, t.reads.indexOf(2 * CHUNK) + 1);
    expect(t.reads.slice(firstRetry).every((r) => r >= 2 * CHUNK)).toBe(true);
    expect(t.progress.some((p) => p.stopped)).toBe(false);
    expect(t.progress.at(-1)).toMatchObject({ bytes: SIZE, targetBytes: SIZE });
    t.fill.stop();
  });

  it('backs off 1, 2, 4, then every 10 s while the NAS stays away', async () => {
    const t = await setup((from) => (from >= 2 * CHUNK ? 'lost' : null));
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) delays.push(await t.nextTimer());
    expect(delays).toEqual([1_000, 2_000, 4_000, 10_000, 10_000, 10_000]);
    expect(t.progress.some((p) => p.stopped)).toBe(false);
    t.fill.stop();
    expect(t.timers).toEqual([]);
  });

  it('stops as failed after two minutes of failing without a break', async () => {
    const t = await setup((from) => (from >= 2 * CHUNK ? 'lost' : null));
    while (t.clock.ms < FILL_GIVE_UP_MS && t.timers.length + 1 > 0) {
      await t.settle();
      if (t.progress.at(-1)?.stopped) break;
      await t.nextTimer();
    }
    await t.settle();
    expect(t.progress.at(-1)).toMatchObject({ stopped: 'failed' });
    expect(t.clock.ms).toBeGreaterThanOrEqual(FILL_GIVE_UP_MS);
    expect(t.timers).toEqual([]);
  });

  it('stops as failed at once when the disc changed on the NAS', async () => {
    const t = await setup((from) => (from >= 2 * CHUNK ? 'changed' : null));
    await t.settle();
    await t.settle();
    expect(t.progress.at(-1)).toMatchObject({ stopped: 'failed' });
    expect(t.timers).toEqual([]);
  });
});
