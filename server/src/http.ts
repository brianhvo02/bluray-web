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

const health: Handler = async (req, url) => {
  if (url.pathname !== '/api/health') return null;
  if (req.method === 'GET') return json(200, { ok: true });
  if (req.method === 'HEAD') return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } };
  return null;
};

/** Above Caddy's 2-minute upstream idle timeout, so Caddy never reuses a connection we have closed. */
const KEEP_ALIVE_TIMEOUT_MS = 130_000;

function send(res: ServerResponse, origin: string | undefined, response: Response): void {
  res.writeHead(response.status, { ...corsHeaders(origin), ...response.headers });
  const { body } = response;
  if (body instanceof Readable) {
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy());
    body.pipe(res);
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
  for (const handler of handlers) {
    const response = await handler(req, url);
    if (response) return response;
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
