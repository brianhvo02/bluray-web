import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { json } from '../http';
import type { Handler, Response } from '../http';
import type { Library } from '../library';
import { buildManifest, discUnchanged, largestClip, resolveDiscFile } from '../manifest';
import { parseRange } from '../ranges';

const PROBE_BYTES = 4_194_304;
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

/** `[start, end]` of `file` (inclusive) as a streamed body; nothing for HEAD or an empty span. */
function bytes(req: IncomingMessage, file: string, status: number, start: number, end: number, headers: Record<string, string> = {}): Response {
  const length = end - start + 1;
  const body = req.method === 'HEAD' || length === 0 ? undefined : createReadStream(file, { start, end });
  return { status, headers: { ...bytesHeaders(length), ...headers }, body };
}

async function serveFile(req: IncomingMessage, file: string): Promise<Response> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return notFound();
  }
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') return { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': '0' } };
  if (range === null) return bytes(req, file, 200, 0, size - 1);
  return bytes(req, file, 206, range.start, range.end, { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` });
}

/**
 * `GET /api/discs/<id>/manifest`, `GET|HEAD /api/discs/<id>/files/<path>` (a `Range` or the whole file) and
 * `GET|HEAD /api/discs/<id>/probe` (the first 4 MiB of the largest clip); `appHandlers` puts the token guard in front.
 */
export function discRoutes(library: Library): Handler {
  return async (req, url) => {
    const match = ROUTE.exec(url.pathname);
    if (!match) return null;
    const [, id = '', action = '', encodedPath] = match;
    const read = action !== 'manifest';
    if (!(req.method === 'GET' || (read && req.method === 'HEAD'))) return null;

    const disc = library.disc(id);
    if (!disc) return discChanged();
    if (disc.kind === 'iso') return json(501, { error: 'iso-not-yet' });
    const dir = library.locate(disc);
    if (!dir || !(await discUnchanged(disc, dir))) return discChanged();

    if (action === 'manifest') return json(200, await buildManifest(dir, disc));
    if (action === 'probe') {
      const clip = await largestClip(dir);
      if (!clip) return notFound();
      return bytes(req, clip.abs, 200, 0, Math.min(clip.size, PROBE_BYTES) - 1);
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
