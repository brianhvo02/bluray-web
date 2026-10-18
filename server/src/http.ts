import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { PREFLIGHT_HEADERS, corsHeaders } from './cors';

export interface Response {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string | Readable;
}

/** Answers a request, or returns null to let the next handler try. */
export type Handler = (req: IncomingMessage, url: URL) => Promise<Response | null>;

export function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(value) };
}

/** Thrown by a handler to answer `status` with `{"error": message}`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const MAX_JSON_BYTES = 16 * 1024;

/** The request's JSON body: 415 unless it is `application/json`, 413 above 16 KiB, 400 if it doesn't parse. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'expected application/json');
  const tooLarge = new HttpError(413, 'body too large', { Connection: 'close' });
  if (Number(req.headers['content-length'] ?? 0) > MAX_JSON_BYTES) throw tooLarge;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw tooLarge;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

const health: Handler = async (req, url) => {
  if (url.pathname !== '/api/health') return null;
  if (req.method === 'GET') return json(200, { ok: true });
  if (req.method === 'HEAD') return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } };
  return null;
};

/** Above Caddy's 2-minute upstream idle timeout, so Caddy never reuses a connection we have closed. */
const KEEP_ALIVE_TIMEOUT_MS = 130_000;

/** On every response: the bytes are user content on a shared origin, so never sniff them or run them as a page. */
const SAFETY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
};

function send(res: ServerResponse, origin: string | undefined, response: Response): void {
  res.writeHead(response.status, { ...SAFETY_HEADERS, ...corsHeaders(origin), ...response.headers });
  const { body } = response;
  if (body instanceof Readable) {
    const length = Number(response.headers?.['Content-Length'] ?? NaN);
    let sent = 0;
    body.on('data', (chunk: Buffer) => (sent += chunk.length));
    body.on('error', () => res.destroy());
    // A file that shrank mid-read: end the connection, or the client waits for bytes that never come.
    body.on('end', () => (Number.isFinite(length) && sent < length ? res.destroy() : res.end()));
    res.on('close', () => body.destroy());
    body.pipe(res, { end: false });
  } else {
    res.end(body);
  }
}

async function route(handlers: readonly Handler[], req: IncomingMessage): Promise<Response> {
  if (req.method === 'OPTIONS') return { status: 204, headers: { ...PREFLIGHT_HEADERS } };
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return json(400, { error: 'bad request' });
  }
  try {
    for (const handler of handlers) {
      const response = await handler(req, url);
      if (response) return response;
    }
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message }, err.headers);
    throw err;
  }
  return json(404, { error: 'not found' });
}

/** An HTTP server running `handlers` after the built-in health check, with CORS on every response. */
export function createServer(handlers: readonly Handler[]): http.Server {
  const all = [health, ...handlers];
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    route(all, req)
      .then((response) => send(res, origin, response))
      .catch((err: unknown) => {
        console.error(err);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        try {
          send(res, origin, json(500, { error: 'internal error' }));
        } catch {
          res.destroy();
        }
      });
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;
  return server;
}
