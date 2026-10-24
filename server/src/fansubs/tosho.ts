/** Anime Tosho client: the JSON feed (https://feed.animetosho.net/json) and the storage downloads. Original code. */
import { RateLimited } from '../titles/pacer';
import { TooLargeArchive } from './archive';
import type { PacedOptions, Pacer } from '../titles/pacer';
import { retryAfterMs, SourceUnavailable } from '../titles/sources';

/** The most a track's .xz download may be. */
export const TRACK_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** The most a font pack's download may be. */
export const PACK_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export interface ToshoTrack {
  /** Index among the file's subtitle attachments, from 0. */
  readonly track: number;
  /** ISO 639-2, `und` when missing. */
  readonly language: string;
  readonly name: string;
  readonly format: string;
  readonly url: string;
  readonly isDefault: boolean;
  readonly forced: boolean;
}

export interface ToshoFile {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly tracks: readonly ToshoTrack[];
}

export interface ToshoRelease {
  readonly id: number;
  readonly title: string;
  readonly infoHash: string;
  readonly status: string;
  readonly isSeadex: boolean;
  /** Seconds since the epoch, as the feed gives it. */
  readonly date: number;
  readonly files: readonly ToshoFile[];
}

export interface Tosho {
  byHash(infoHash: string, opts?: PacedOptions): Promise<ToshoRelease | null>;
  byId(id: number, opts?: PacedOptions): Promise<ToshoRelease | null>;
  /** The first page (at most 30 releases), files not loaded. */
  search(query: string, opts?: PacedOptions): Promise<readonly ToshoRelease[]>;
  /** The bytes at `url`; past `maxBytes` (declared or as they arrive) it throws `TooLargeArchive`. */
  download(url: string, opts?: PacedOptions, maxBytes?: number): Promise<Buffer>;
  fontPackUrl(fileId: number): string;
}

/** A download Anime Tosho answers 404. */
export class NotFoundOnTosho extends Error {
  override name = 'NotFoundOnTosho';
  constructor(url: string) {
    super(`not found on Anime Tosho: ${url}`);
  }
}

interface RawAttachment {
  readonly type?: string;
  readonly url?: string;
  readonly info?: {
    readonly format?: string | null;
    readonly language_code?: string | null;
    readonly name?: string | null;
    readonly default?: boolean | null;
    readonly forced?: boolean | null;
  } | null;
}
interface RawFile {
  readonly id: number;
  readonly filename?: string | null;
  readonly size?: number | null;
  readonly attachments?: readonly RawAttachment[] | null;
}
interface RawRelease {
  readonly id: number;
  readonly title?: string | null;
  readonly info_hash?: string | null;
  readonly status?: string | null;
  readonly is_seadex?: boolean | null;
  readonly timestamp?: number | null;
  readonly files?: readonly RawFile[] | null;
}

function toFile(f: RawFile): ToshoFile {
  const tracks = (f.attachments ?? [])
    .filter((a) => a.type === 'subtitle' && typeof a.url === 'string')
    .map((a, track): ToshoTrack => ({
      track,
      language: a.info?.language_code || 'und',
      name: a.info?.name ?? '',
      format: a.info?.format ?? '',
      url: a.url!,
      isDefault: a.info?.default === true,
      forced: a.info?.forced === true,
    }));
  return { id: f.id, name: f.filename ?? '', size: f.size ?? 0, tracks };
}

function toRelease(r: RawRelease): ToshoRelease {
  return {
    id: r.id,
    title: r.title ?? '',
    infoHash: r.info_hash ?? '',
    status: r.status ?? '',
    isSeadex: r.is_seadex === true,
    date: r.timestamp ?? 0,
    files: (r.files ?? []).map(toFile),
  };
}

/** A response's body, refused by its Content-Length or once more than `maxBytes` have arrived. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const tooLarge = (): TooLargeArchive => new TooLargeArchive(`download over ${maxBytes} bytes`);
  if (Number(res.headers.get('Content-Length') ?? 0) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof TooLargeArchive) throw e;
    throw new SourceUnavailable('animetosho: download interrupted');
  }
  return Buffer.concat(chunks, size);
}

export function createTosho(fetch: typeof globalThis.fetch, pacer: Pacer, userAgent: string, bases: { feed: string; site: string }): Tosho {
  /** One paced GET; the raw response when it is fine. */
  const get = async (url: string, accept: string, notFound: () => Error): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: accept }, redirect: 'follow' });
    } catch {
      throw new SourceUnavailable('animetosho: network error');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 429) throw new RateLimited(retryAfterMs(res.headers.get('Retry-After')));
      if (res.status === 404) throw notFound();
      throw new SourceUnavailable(`animetosho: HTTP ${res.status}`);
    }
    return res;
  };

  const feed = (query: string, opts?: PacedOptions): Promise<unknown> =>
    pacer.run(async () => {
      const res = await get(`${bases.feed}/json?${query}`, 'application/json', () => new SourceUnavailable('animetosho: HTTP 404'));
      try {
        return await res.json();
      } catch {
        throw new SourceUnavailable('animetosho: unreadable response');
      }
    }, opts);

  const torrent = async (query: string, opts?: PacedOptions): Promise<ToshoRelease | null> => {
    const body = (await feed(`show=torrent&${query}`, opts)) as (RawRelease & { error?: unknown }) | null;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SourceUnavailable('animetosho: unexpected response');
    if ('error' in body) return null;
    if (typeof body.id !== 'number') throw new SourceUnavailable('animetosho: unexpected response');
    return toRelease(body);
  };

  return {
    byHash: (infoHash, opts) => torrent(`btih=${encodeURIComponent(infoHash)}`, opts),
    byId: (id, opts) => torrent(`id=${id}`, opts),
    async search(query, opts) {
      const body = await feed(`q=${encodeURIComponent(query)}`, opts);
      if (!Array.isArray(body)) {
        if (typeof body === 'object' && body !== null && 'error' in body) return [];
        throw new SourceUnavailable('animetosho: unexpected response');
      }
      return (body as RawRelease[]).slice(0, 30).map((r) => toRelease({ ...r, files: [] }));
    },
    download: (url, opts, maxBytes = PACK_DOWNLOAD_BYTES) =>
      pacer.run(async () => {
        const res = await get(url, '*/*', () => new NotFoundOnTosho(url));
        return readCapped(res, maxBytes);
      }, opts),
    fontPackUrl: (fileId) => `${bases.site}/download/file/${fileId}/attachments`,
  };
}
