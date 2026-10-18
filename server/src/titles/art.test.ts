import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('M4: fetches only https images from AniList and TMDB image hosts', async () => {
    const fetch = fetcher();
    const art = new ArtCache(dir, fetch);
    for (const url of ['http://s4.anilist.co/a.jpg', 'https://evil.example/a.jpg', 'https://s4.anilist.co.evil.example/a.jpg', 'https://user@evil.example/a.jpg', 'file:///etc/passwd', 'not a url']) {
      expect(await art.get(ID1, 'small', url), url).toBeNull();
    }
    expect(fetch.urls).toEqual([]);
    expect(await art.get(ID1, 'small', 'https://image.tmdb.org/t/p/w185/a.jpg')).not.toBeNull();
    expect(await art.get(ID2, 'small', 'https://s4.anilist.co/file/a.jpg')).not.toBeNull();
  });

  it('stores a fetched image under art/<artId>-<size> with its content type', async () => {
    const fetch = fetcher();
    const art = new ArtCache(dir, fetch);
    const got = await art.get(ID1, 'large', 'https://s4.anilist.co/l/1.jpg');
    expect(got).toEqual({ path: join(dir, `${ID1}-large`), type: 'image/jpeg' });
    expect(readFileSync(got!.path)).toEqual(Buffer.from(new Uint8Array(10).fill(7)));
    expect(fetch.urls).toEqual(['https://s4.anilist.co/l/1.jpg']);
    // and a new cache on the same dir knows its type
    expect(await new ArtCache(dir, fetcher()).get(ID1, 'large', 'https://s4.anilist.co/l/1.jpg')).toEqual(got);
  });

  it('does not fetch an image it has', async () => {
    const fetch = fetcher();
    const art = new ArtCache(dir, fetch);
    await art.get(ID1, 'small', 'https://s4.anilist.co/s/1.jpg');
    await art.get(ID1, 'small', 'https://s4.anilist.co/s/1.jpg');
    expect(fetch.urls.length).toBe(1);
  });

  it('deletes the least recently used files past its budget', async () => {
    let t = 0;
    const art = new ArtCache(dir, fetcher(10), 25, { now: () => ++t });
    await art.get(ID1, 'small', 'https://s4.anilist.co/1');
    await art.get(ID2, 'small', 'https://s4.anilist.co/2');
    await art.get(ID1, 'small', 'https://s4.anilist.co/1'); // ID1 is now the more recently used
    await art.get(ID3, 'small', 'https://s4.anilist.co/3');
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(true);
    expect(existsSync(join(dir, `${ID2}-small`))).toBe(false);
    expect(existsSync(join(dir, `${ID3}-small`))).toBe(true);
  });

  it('returns null when the fetch fails', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('network');
    }) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, failing).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    const notFound = vi.fn(async () => new Response('no', { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, notFound).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    const notImage = vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, notImage).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(false);
  });

  it('stores only jpeg, png, webp and gif, and only the two sizes (T8f)', async () => {
    const typed = (type: string) => vi.fn(async () => new Response('x', { headers: { 'content-type': type } })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, typed('image/svg+xml')).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    expect(await new ArtCache(dir, typed('image/avif')).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(await new ArtCache(dir, typed(type)).get(ID2, 'large', `https://s4.anilist.co/${type}`)).toMatchObject({ type });
      rmSync(dir, { recursive: true });
    }
    const fetch = fetcher();
    expect(await new ArtCache(dir, fetch).get(ID1, 'huge' as 'small', 'https://s4.anilist.co/1')).toBeNull();
    expect(fetch.urls).toEqual([]);
  });

  it('gives up on a body past its cap, streaming, and on a fetch that takes too long (T8f)', async () => {
    let pulled = 0;
    const endless = vi.fn(async () => new Response(new ReadableStream({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(4));
      },
    }), { headers: { 'content-type': 'image/png' } })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, endless, undefined, { maxBytes: 10 }).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(false);

    const hanging = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, hanging, undefined, { timeoutMs: 20 }).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
  });

  it('caps the body at 5 MB and times out after 15 s by default', async () => {
    const big = vi.fn(async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, big).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await new ArtCache(dir, fetcher()).get(ID2, 'small', 'https://s4.anilist.co/2');
    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockRestore();
  });

  it('saves hit times soon after a hit, so a restarted cache evicts by them (T8f)', async () => {
    let t = 0;
    const now = (): number => ++t;
    const art = new ArtCache(dir, fetcher(10), 25, { now, saveDelayMs: 5 });
    await art.get(ID1, 'small', 'https://s4.anilist.co/1');
    await art.get(ID2, 'small', 'https://s4.anilist.co/2');
    await art.get(ID1, 'small', 'https://s4.anilist.co/1');
    // 10 s, not vi.waitFor's 1 s default: a loaded CI runner can miss the debounced save by more than a second
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))[`${ID1}-small`].usedAt).toBe(3), { timeout: 10_000 });
    const restarted = new ArtCache(dir, fetcher(10), 25, { now });
    await restarted.get(ID3, 'small', 'https://s4.anilist.co/3');
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(true);
    expect(existsSync(join(dir, `${ID2}-small`))).toBe(false);
  });

  it('counts files missing from its index against the budget at startup (T8f)', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID2}-small`), new Uint8Array(20));
    const art = new ArtCache(dir, fetcher(10), 25);
    await art.get(ID1, 'small', 'https://s4.anilist.co/1');
    expect(existsSync(join(dir, `${ID2}-small`))).toBe(false);
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(true);
  });
});
