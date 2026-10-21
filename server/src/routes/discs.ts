import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { parseDiscKey } from '../../../src/engine/disc/disc-key';
import type { DiscEntry } from '../../../src/engine/disc/nas-api';
import { json } from '../http';
import type { Handler, Response } from '../http';
import { IsoTrees, isoFileStream, isoUnchanged } from '../iso';
import type { Library } from '../library';
import { buildIsoManifest, buildManifest, discUnchanged, largestClip, largestIsoClip, resolveDiscFile, resolveIsoFile } from '../manifest';
import { parseRange } from '../ranges';

const PROBE_BYTES = 4_194_304;
const RESOLVE = /^\/api\/discs\/resolve\/([^/]+)$/;
const ROUTE = /^\/api\/discs\/([^/]+)\/(manifest|probe|files\/(.+))$/;

const notFound = (): Response => json(404, { error: 'not found' });
const discChanged = (): Response => json(404, { error: 'disc-changed' });

function bytesHeaders(length: number): Record<string, string> {
  return {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Length': String(length),
  };
}

/** Opens bytes `[start, end]` (inclusive) of a file. */
type OpenBytes = (start: number, end: number) => Readable;

/** `[start, end]` (inclusive) as a streamed body; nothing for HEAD or an empty span. */
function bytes(req: IncomingMessage, open: OpenBytes, status: number, start: number, end: number, headers: Record<string, string> = {}): Response {
  const length = end - start + 1;
  const body = req.method === 'HEAD' || length === 0 ? undefined : open(start, end);
  return { status, headers: { ...bytesHeaders(length), ...headers }, body };
}

/** A file of `size` bytes: the `Range` asked for, or all of it. */
function serveBytes(req: IncomingMessage, size: number, open: OpenBytes): Response {
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') return { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': '0' } };
  if (range === null) return bytes(req, open, 200, 0, size - 1);
  return bytes(req, open, 206, range.start, range.end, { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` });
}

async function serveFile(req: IncomingMessage, file: string): Promise<Response> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return notFound();
  }
  return serveBytes(req, size, (start, end) => createReadStream(file, { start, end }));
}

const ISO_TREES = 32;

/**
 * `GET /api/discs/<id>/manifest`, `GET|HEAD /api/discs/<id>/files/<path>` (a `Range` or the whole file) and
 * `GET|HEAD /api/discs/<id>/probe` (the first 4 MiB of the largest clip); `appHandlers` puts the token guard in front.
 */
export function discRoutes(library: Library): Handler {
  const isoTrees = new IsoTrees(ISO_TREES);

  /** The same three actions for an ISO disc, from its UDF tree (parsed once per disc id). */
  const isoRoute = async (req: IncomingMessage, disc: DiscEntry, action: string, encodedPath: string | undefined): Promise<Response> => {
    const abs = library.locate(disc);
    if (!abs || !(await isoUnchanged(disc, abs))) return discChanged();
    let tree;
    try {
      tree = await isoTrees.get(disc.id, abs);
    } catch (err) {
      // Replaced while we read it: the client should rescan. Otherwise it is a real failure.
      if (!(await isoUnchanged(disc, abs))) return discChanged();
      throw err;
    }
    if (action === 'manifest') return json(200, await buildIsoManifest(abs, tree, disc));
    if (action === 'probe') {
      const clip = largestIsoClip(tree);
      if (!clip) return notFound();
      return bytes(req, (start, end) => isoFileStream(abs, clip, start, end), 200, 0, Math.min(clip.size, PROBE_BYTES) - 1);
    }
    let path: string;
    try {
      path = decodeURIComponent(encodedPath!);
    } catch {
      return notFound();
    }
    const file = resolveIsoFile(tree, path);
    return file ? serveBytes(req, file.size, (start, end) => isoFileStream(abs, file, start, end)) : notFound();
  };

  /** The listed disc a link key names. Several copies of one fingerprint answer the one with the smallest path (byte order). */
  const resolve = (key: string): DiscEntry | null => {
    const parsed = parseDiscKey(key);
    if (!parsed) return null;
    if (parsed.kind === 'disc') return library.disc(parsed.discId) ?? null;
    let best: { discId: string; path: string } | null = null;
    for (const ev of library.evidence()) {
      if (ev.fingerprint !== parsed.fingerprint) continue;
      if (best === null || Buffer.compare(Buffer.from(ev.path), Buffer.from(best.path)) < 0) best = ev;
    }
    return best ? (library.disc(best.discId) ?? null) : null;
  };

  return async (req, url) => {
    const resolved = RESOLVE.exec(url.pathname);
    if (resolved) {
      if (req.method !== 'GET') return null;
      const disc = resolve(decodeURIComponent(resolved[1]!));
      return disc ? json(200, { disc }) : json(404, { error: 'not-found' });
    }
    const match = ROUTE.exec(url.pathname);
    if (!match) return null;
    const [, id = '', action = '', encodedPath] = match;
    const read = action !== 'manifest';
    if (!(req.method === 'GET' || (read && req.method === 'HEAD'))) return null;

    const disc = library.disc(id);
    if (!disc) return discChanged();
    if (disc.kind === 'iso') return isoRoute(req, disc, action, encodedPath);
    const dir = library.locate(disc);
    if (!dir || !(await discUnchanged(disc, dir))) return discChanged();

    if (action === 'manifest') return json(200, await buildManifest(dir, disc));
    if (action === 'probe') {
      const clip = await largestClip(dir);
      if (!clip) return notFound();
      return bytes(req, (start, end) => createReadStream(clip.abs, { start, end }), 200, 0, Math.min(clip.size, PROBE_BYTES) - 1);
    }
    let path: string;
    try {
      path = decodeURIComponent(encodedPath!);
    } catch {
      return notFound();
    }
    const file = await resolveDiscFile(dir, path);
    return file ? serveFile(req, file) : notFound();
  };
}
