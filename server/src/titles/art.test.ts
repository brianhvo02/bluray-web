import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtCache } from './art';

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'art-')), 'art');
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

const ID1 = 'a'.repeat(32);
const ID2 = 'b'.repeat(32);
const ID3 = 'c'.repeat(32);

/** A fetch answering `bytes` bytes of image/jpeg for every URL, recording the URLs. */
function fetcher(bytes = 10): typeof globalThis.fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(new Uint8Array(bytes).fill(7), { headers: { 'content-type': 'image/jpeg' } });
  });
  return Object.assign(f as unknown as typeof globalThis.fetch, { urls });
}

describe('ArtCache', () => {
  it('stores a fetched image under art/<artId>-<size> with its content type', async () => {
    const fetch = fetcher();
    const art = new ArtCache(dir, fetch);
    const got = await art.get(ID1, 'large', 'https://img.example/l/1.jpg');
    expect(got).toEqual({ path: join(dir, `${ID1}-large`), type: 'image/jpeg' });
    expect(readFileSync(got!.path)).toEqual(Buffer.from(new Uint8Array(10).fill(7)));
    expect(fetch.urls).toEqual(['https://img.example/l/1.jpg']);
    // and a new cache on the same dir knows its type
    expect(await new ArtCache(dir, fetcher()).get(ID1, 'large', 'https://img.example/l/1.jpg')).toEqual(got);
  });

  it('does not fetch an image it has', async () => {
    const fetch = fetcher();
    const art = new ArtCache(dir, fetch);
    await art.get(ID1, 'small', 'https://img.example/s/1.jpg');
    await art.get(ID1, 'small', 'https://img.example/s/1.jpg');
    expect(fetch.urls.length).toBe(1);
  });

  it('deletes the least recently used files past its budget', async () => {
    let t = 0;
    const art = new ArtCache(dir, fetcher(10), 25, () => ++t);
    await art.get(ID1, 'small', 'https://img.example/1');
    await art.get(ID2, 'small', 'https://img.example/2');
    await art.get(ID1, 'small', 'https://img.example/1'); // ID1 is now the more recently used
    await art.get(ID3, 'small', 'https://img.example/3');
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(true);
    expect(existsSync(join(dir, `${ID2}-small`))).toBe(false);
    expect(existsSync(join(dir, `${ID3}-small`))).toBe(true);
  });

  it('returns null when the fetch fails', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('network');
    }) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, failing).get(ID1, 'small', 'https://img.example/1')).toBeNull();
    const notFound = vi.fn(async () => new Response('no', { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, notFound).get(ID1, 'small', 'https://img.example/1')).toBeNull();
    const notImage = vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, notImage).get(ID1, 'small', 'https://img.example/1')).toBeNull();
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(false);
  });
});
