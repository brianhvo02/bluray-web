import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SegmentCache } from './segment-cache';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'segment-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (n: number, fill: number): Buffer => Buffer.alloc(n, fill);

describe('SegmentCache', () => {
  it('round-trips an interval under <dir>/<disc>/<level>/<audio>/<clip>/', async () => {
    const cache = new SegmentCache(dir, 1 << 20);
    const key = cache.key('a1b2c3', 'h264-1080', 1, '00001', 123_456, 1_700_000_000_123);
    expect(await cache.get(key, 4)).toBeNull();
    await cache.put(key, 4, bytes(6144, 7));
    expect(await cache.get(key, 4)).toEqual(bytes(6144, 7));
    expect(await cache.get(key, 5)).toBeNull();
    expect(existsSync(join(dir, 'a1b2c3', 'h264-1080', '1', '00001'))).toBe(true);
    // No temporary file is left behind.
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' });
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('knows which intervals it holds, from this run and earlier ones', async () => {
    const cache = new SegmentCache(dir, 1 << 20);
    const key = cache.key('a1b2c3', 'h264-1080', 1, '00001', 1000, 5000);
    expect(await cache.has(key, 2)).toBe(false);
    await cache.put(key, 2, bytes(10, 1));
    expect(await cache.has(key, 2)).toBe(true);
    expect(await cache.has(key, 3)).toBe(false);
    expect(await new SegmentCache(dir, 1 << 20).has(key, 2)).toBe(true);
  });

  it('misses when the clip changed size or mtime', async () => {
    const cache = new SegmentCache(dir, 1 << 20);
    await cache.put(cache.key('a1b2c3', 'h264-1080', 1, '00001', 1000, 5000), 0, bytes(10, 1));
    expect(await cache.get(cache.key('a1b2c3', 'h264-1080', 1, '00001', 1000, 5000), 0)).not.toBeNull();
    expect(await cache.get(cache.key('a1b2c3', 'h264-1080', 1, '00001', 1001, 5000), 0)).toBeNull();
    expect(await cache.get(cache.key('a1b2c3', 'h264-1080', 1, '00001', 1000, 5001), 0)).toBeNull();
    // Other levels, audio streams and clips are other keys.
    expect(await cache.get(cache.key('a1b2c3', 'phone-720', 1, '00001', 1000, 5000), 0)).toBeNull();
    expect(await cache.get(cache.key('a1b2c3', 'h264-1080', 2, '00001', 1000, 5000), 0)).toBeNull();
    expect(await cache.get(cache.key('a1b2c3', 'h264-1080', 1, '00002', 1000, 5000), 0)).toBeNull();
  });

  it('evicts the least recently used whole files past its byte limit', async () => {
    const cache = new SegmentCache(dir, 3000);
    const key = cache.key('a1b2c3', 'h264-1080', 1, '00001', 1000, 5000);
    await cache.put(key, 0, bytes(1000, 0));
    await cache.put(key, 1, bytes(1000, 1));
    await cache.put(key, 2, bytes(1000, 2));
    // A read makes 0 the most recent; 1 is now the oldest.
    expect(await cache.get(key, 0)).not.toBeNull();
    await cache.put(key, 3, bytes(1000, 3));
    expect(await cache.get(key, 1)).toBeNull();
    expect(await cache.get(key, 0)).toEqual(bytes(1000, 0));
    expect(await cache.get(key, 2)).toEqual(bytes(1000, 2));
    expect(await cache.get(key, 3)).toEqual(bytes(1000, 3));
    expect(cache.totalBytes).toBe(3000);
  });

  it('knows what an earlier run left on disk, and removes stray temporary files', async () => {
    const first = new SegmentCache(dir, 2500);
    const key = first.key('a1b2c3', 'h264-1080', 1, '00001', 1000, 5000);
    await first.put(key, 0, bytes(1000, 0));
    await first.put(key, 1, bytes(1000, 1));
    const clipDir = join(dir, 'a1b2c3', 'h264-1080', '1', '00001');
    const stamp = readdirSync(clipDir)[0]!;
    writeFileSync(join(clipDir, stamp, '7.seg.1234.tmp'), 'partial');

    const second = new SegmentCache(dir, 2500);
    expect(await second.get(key, 1)).toEqual(bytes(1000, 1));
    expect(second.totalBytes).toBe(2000);
    expect(existsSync(join(clipDir, stamp, '7.seg.1234.tmp'))).toBe(false);
    await second.put(key, 2, bytes(1000, 2));
    // 0 was the oldest on disk.
    expect(await second.get(key, 0)).toBeNull();
    expect(second.totalBytes).toBe(2000);
  });

  it('removes a clip directory once its last file is evicted', async () => {
    const cache = new SegmentCache(dir, 1500);
    const old = cache.key('d1', 'h264-1080', 1, '00001', 1000, 5000);
    await cache.put(old, 0, bytes(1000, 0));
    await cache.put(cache.key('d2', 'h264-1080', 1, '00001', 1000, 5000), 0, bytes(1000, 1));
    expect(existsSync(join(dir, 'd1'))).toBe(false);
    expect(existsSync(join(dir, 'd2'))).toBe(true);
  });

  it('keeps the first of two concurrent writes to one interval, counted once', async () => {
    const cache = new SegmentCache(dir, 1 << 20);
    const key = cache.key('a1b2c3', 'h264-1080', 1, '00001', 1000, 5000);
    await Promise.all([cache.put(key, 0, bytes(1000, 1)), cache.put(key, 0, bytes(1000, 2)), cache.put(key, 0, bytes(1000, 3))]);
    const got = await cache.get(key, 0);
    expect(got?.length).toBe(1000);
    expect(new Set(got).size).toBe(1);
    expect(cache.totalBytes).toBe(1000);
    await cache.put(key, 0, bytes(1000, 9));
    expect(await cache.get(key, 0)).toEqual(got);
    expect(cache.totalBytes).toBe(1000);
    expect(readdirSync(dir, { recursive: true, encoding: 'utf8' }).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('refuses key parts that would leave its directory', () => {
    const cache = new SegmentCache(dir, 1000);
    expect(() => cache.key('..', 'h264-1080', 1, '00001', 1, 1)).toThrow();
    expect(() => cache.key('a1', 'h264-1080', 1, '../x', 1, 1)).toThrow();
    expect(() => cache.key('a1', 'h264/1080', 1, '00001', 1, 1)).toThrow();
  });
});
