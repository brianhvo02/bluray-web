import type { IncomingMessage } from 'node:http';
import { LockHeldError } from '../atomic-json';
import type { Auth } from '../auth';
import { parseScope, StoreError } from '../bdj-store';
import type { BdjStore } from '../bdj-store';
import { HttpError, json } from '../http';
import type { Handler, Response } from '../http';
import { requestDevice } from './titles';

const PREFIX = '/api/bdj-store/';
/** The request body was not read to its end, so the connection can't carry another request. */
const CLOSE = { Connection: 'close' };

const quota = (limit: 'scope' | 'person', headers: Record<string, string> = {}): Response => json(507, { error: 'quota', limit }, headers);
const precondition = (): Response => json(412, { error: 'precondition-failed' });

/** `If-Match`: `*`, or one quoted etag (its bare value); null when absent; undefined when malformed. */
function ifMatch(req: IncomingMessage): string | null | undefined {
  const raw = req.headers['if-match']?.trim();
  if (raw === undefined) return null;
  if (raw === '*') return '*';
  const m = /^"([^"]+)"$/.exec(raw);
  return m ? m[1]! : undefined;
}

/** After refusing a body, how far past the limit it is read and dropped, and for how long, so the client sees the 507. */
const DRAIN_BYTES = 8 * 1024 * 1024;
const DRAIN_MS = 2_000;

/**
 * The body, or null once it passes `limit` bytes (declared or streamed). A refused body is never kept: it is read
 * and dropped until it ends, passes the limit by 8 MB or 2 s go by, whichever comes first, because closing the
 * connection on unread bytes would reset it before the client reads the answer. A 400 if the client goes.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', gone);
      req.off('close', gone);
    };
    const refuse = (): void => {
      refused = true;
      chunks.length = 0;
      timer = setTimeout(stopDraining, DRAIN_MS);
    };
    const stopDraining = (): void => {
      done();
      req.pause();
      resolve(null);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (!refused && size > limit) refuse();
      if (!refused) chunks.push(chunk);
      else if (size > limit + DRAIN_BYTES) stopDraining();
    };
    const onEnd = (): void => {
      done();
      resolve(refused ? null : Buffer.concat(chunks));
    };
    // a client gone mid-upload (a page closing) is not a server fault: no answer reaches it, and nothing is logged
    const gone = (): void => {
      done();
      reject(new HttpError(400, 'request ended early'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', gone);
    req.on('close', gone);
    if (Number(req.headers['content-length'] ?? 0) > limit) refuse();
  });
}

/** A StoreError as its answer (spec §5); anything else is rethrown. */
function storeFailure(err: unknown): Response {
  if (err instanceof StoreError) {
    switch (err.code) {
      case 'precondition':
        return precondition();
      case 'quota-scope':
        return quota('scope');
      case 'quota-person':
        return quota('person');
      case 'bad-archive':
        return json(400, { error: 'bad-archive' });
    }
  }
  // another writer of the scope held its lock for the whole wait
  if (err instanceof LockHeldError) return json(503, { error: 'busy' }, { 'Retry-After': '1' });
  throw err;
}

/**
 * `GET`, `PUT` and `DELETE /api/bdj-store/<scope>` (spec §5): the token's own person's BD-J saved data, one ustar
 * snapshot per scope, under quoted ETags. Behind `requireToken`; the token may come as `Authorization: Bearer` or `t=`.
 */
export function bdjStoreRoutes(auth: Auth, store: BdjStore): Handler {
  return async (req, url) => {
    const path = url.pathname;
    if (path !== PREFIX.slice(0, -1) && !path.startsWith(PREFIX)) return null;
    const method = req.method;
    if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return json(405, { error: 'method not allowed' }, { Allow: 'GET, PUT, DELETE' });
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    const scope = parseScope(path.slice(PREFIX.length));
    if (scope === null) return json(400, { error: 'bad-scope' }, method === 'PUT' ? CLOSE : {});
    const person = device.personId;

    if (method === 'GET') {
      const { etag, body } = store.get(person, scope);
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/x-tar',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
          ...(etag === null ? {} : { ETag: `"${etag}"` }),
        },
        body,
      };
    }

    const match = ifMatch(req);
    if (match === undefined) return json(400, { error: 'bad-if-match' }, method === 'PUT' ? CLOSE : {});
    // `If-Match: *` stands for whatever snapshot is there; with none, it fails
    const resolve = (m: string): string | null => (m === '*' ? store.get(person, scope).etag : m);

    if (method === 'DELETE') {
      if (match === null) return json(428, { error: 'precondition-required' });
      const etag = resolve(match);
      if (etag === null) return precondition();
      try {
        store.delete(person, scope, etag);
      } catch (err) {
        return storeFailure(err);
      }
      return { status: 204 };
    }

    const noneMatch = req.headers['if-none-match']?.trim() === '*';
    if (match === null && !noneMatch) return json(428, { error: 'precondition-required' }, CLOSE);
    const body = await readBody(req, store.scopeLimit);
    if (body === null) return quota('scope', CLOSE);
    let cond: { ifMatch?: string; ifNoneMatch?: boolean };
    if (match !== null) {
      const etag = resolve(match);
      if (etag === null) return precondition();
      cond = { ifMatch: etag };
    } else {
      cond = { ifNoneMatch: true };
    }
    try {
      const { etag } = store.put(person, scope, body, cond);
      return { status: 200, headers: { ETag: `"${etag}"` } };
    } catch (err) {
      return storeFailure(err);
    }
  };
}
