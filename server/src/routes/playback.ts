import type { IncomingMessage } from 'node:http';
import { parseDiscKey } from '../../../src/engine/disc/disc-key';
import { LockHeldError } from '../atomic-json';
import type { Auth } from '../auth';
import { HttpError, json } from '../http';
import type { Handler } from '../http';
import { isPlaybackPlace, isPlaylistId, PLACE_LIMIT_BYTES } from '../playback-store';
import type { PlaybackStore } from '../playback-store';
import { requestDevice } from './titles';

const PREFIX = '/api/me/playback/';

/** The body as JSON, a 413 once it passes the limit (declared or streamed), a 400 when it doesn't parse. */
async function readPlace(req: IncomingMessage): Promise<unknown> {
  const tooLarge = new HttpError(413, 'body too large', { Connection: 'close' });
  if (Number(req.headers['content-length'] ?? 0) > PLACE_LIMIT_BYTES) throw tooLarge;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > PLACE_LIMIT_BYTES) throw tooLarge;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

/**
 * `GET` and `DELETE /api/me/playback/<discKey>`, `PUT` and `DELETE /api/me/playback/<discKey>/<playlistId>`: the
 * token's own person's places. Behind `requireToken`.
 */
export function playbackRoutes(auth: Auth, store: PlaybackStore): Handler {
  return async (req, url) => {
    if (!url.pathname.startsWith(PREFIX)) return null;
    const method = req.method;
    if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return json(405, { error: 'method not allowed' }, { Allow: 'GET, PUT, DELETE' });
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    const [discKey, playlistId, ...rest] = url.pathname.slice(PREFIX.length).split('/');
    if (rest.length > 0 || parseDiscKey(discKey!) === null || (playlistId !== undefined && !isPlaylistId(playlistId))) return json(404, { error: 'not found' }, method === 'PUT' ? { Connection: 'close' } : {});
    const person = device.personId;
    try {
      if (method === 'GET') {
        if (playlistId !== undefined) return json(405, { error: 'method not allowed' }, { Allow: 'PUT, DELETE' });
        const places = store.get(person, discKey!);
        return places ? json(200, places, { 'Cache-Control': 'no-store' }) : json(404, { error: 'not found' });
      }
      if (method === 'DELETE') {
        store.delete(person, discKey!, playlistId);
        return { status: 204 };
      }
      if (playlistId === undefined) return json(405, { error: 'method not allowed' }, { Allow: 'GET, DELETE', Connection: 'close' });
      const body = await readPlace(req);
      if (!isPlaybackPlace(body)) return json(400, { error: 'bad-place' });
      if (body.discKey !== discKey || body.playlistId !== playlistId) return json(400, { error: 'key-mismatch' });
      return store.put(person, body) === 'stale' ? json(409, { error: 'stale' }) : { status: 204 };
    } catch (err) {
      if (err instanceof LockHeldError) return json(503, { error: 'busy' }, { 'Retry-After': '1' });
      throw err;
    }
  };
}
