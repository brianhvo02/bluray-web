/*
 * Original code for bluray-web: a disc served over HTTP with byte ranges (tools/disc-server, later the NAS server).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { DiscError, type ByteSource } from './byte-source';
import { normalizeDiscPaths } from './paths';

/** Where a served disc lives: `baseUrl` is the disc's URL on the server (`…/discs/<id>`), `token` the server's run token. */
export interface HttpDiscRef {
  readonly baseUrl: string;
  readonly token: string;
}

/** The files a disc's source is built from, as they cross between workers: picked files, or a served disc. */
export type DiscFiles = ReadonlyArray<readonly [string, Blob]>;
export type DiscSourceRef = { readonly kind: 'files'; readonly entries: DiscFiles } | ({ readonly kind: 'http' } & HttpDiscRef);

interface ServedFile {
  /** The path as the server spells it (its case), used in file URLs. */
  readonly path: string;
  readonly size: number;
}

/**
 * ByteSource over a served disc. The manifest (`GET <base>/manifest`) gives every path and size up front, so
 * exists/size/list stay synchronous; reads are `GET <base>/file/<path>` with a Range header.
 */
export class HttpSource implements ByteSource {
  private constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly files: ReadonlyMap<string, ServedFile>,
  ) {}

  static async open(baseUrl: string, token: string, signal?: AbortSignal): Promise<HttpSource> {
    const base = baseUrl.replace(/\/+$/, '');
    const response = await request(`${base}/manifest`, token, {}, signal, 'the disc manifest');
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      throw new DiscError('read-failed', `The disc server sent a manifest that is not JSON: ${String(err)}`);
    }
    const files = parseManifest(body);
    return new HttpSource(base, token, normalizeDiscPaths(files.map((f) => [f.path, f] as const)));
  }

  exists(path: string): boolean {
    return this.files.has(path.toUpperCase());
  }

  size(path: string): number {
    return this.get(path).size;
  }

  /** The normalised (upper-case) paths of every file. */
  paths(): string[] {
    return [...this.files.keys()];
  }

  list(dir: string): string[] {
    const prefix = `${dir.toUpperCase().replace(/\/$/, '')}/`;
    const names: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest !== '' && !rest.includes('/')) names.push(rest);
    }
    return names.sort();
  }

  async read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`invalid read offset ${offset} in ${path}`);
    const file = this.get(path);
    const end = Math.min(offset + length, file.size);
    if (offset >= end) return new Uint8Array(0);
    signal?.throwIfAborted();
    const url = `${this.baseUrl}/file/${file.path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await request(url, this.token, { Range: `bytes=${offset}-${end - 1}` }, signal, path);
    // 200 is the whole file: acceptable only when the whole file was asked for
    if (response.status !== 206 && !(response.status === 200 && offset === 0 && end === file.size)) {
      void response.body?.cancel().catch(() => undefined);
      throw new DiscError('read-failed', `Failed to read ${path}: the disc server answered ${response.status} to a range request`, [path]);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      throw new DiscError('read-failed', `Failed to read ${path}: ${String(err)}`, [path]);
    }
    if (bytes.length !== end - offset) {
      throw new DiscError('read-failed', `Failed to read ${path}: the disc server sent ${bytes.length} of ${end - offset} bytes`, [path]);
    }
    return bytes;
  }

  private get(path: string): ServedFile {
    const file = this.files.get(path.toUpperCase());
    if (!file) throw new DiscError('missing-file', `Missing file ${path}`, [path]);
    return file;
  }
}

/** A GET with the token; network failures and non-2xx answers become DiscError('read-failed'), an abort its reason. */
async function request(url: string, token: string, headers: Record<string, string>, signal: AbortSignal | undefined, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${token}` }, signal, cache: 'no-store' });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw new DiscError('read-failed', `Could not reach the disc server for ${what}: ${String(err)}`, [what]);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    const why = response.status === 401 ? ' (the token is wrong or from an earlier run of the server)' : '';
    throw new DiscError('read-failed', `The disc server answered ${response.status} for ${what}${why}`, [what]);
  }
  return response;
}

function parseManifest(body: unknown): ServedFile[] {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) throw new DiscError('read-failed', 'The disc server sent a manifest without a file list.');
  return files.map((f: unknown) => {
    const { path, size } = (f ?? {}) as { path?: unknown; size?: unknown };
    if (typeof path !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new DiscError('read-failed', `The disc server's manifest has a bad entry: ${JSON.stringify(f)}`);
    }
    return { path, size };
  });
}
