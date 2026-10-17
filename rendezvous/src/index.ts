/**
 * bluray-rendezvous: turns a pairing code into "this NAS and how to reach it".
 * The NAS registers its key (`POST /nas`) and signed code hashes (`POST /codes`, server to server);
 * the app looks a typed code up (`POST /codes/lookup`, CORS for the app's origins).
 */
import { PREFLIGHT_MAX_AGE, corsHeaders } from '../../src/engine/disc/cors-policy';
import { json } from './code-registry';

export { CodeRegistry } from './code-registry';

/** The part of `DurableObjectNamespace` the Worker uses. */
export interface RegistryNamespace {
  idFromName(name: string): object;
  get(id: object): { fetch(request: Request): Promise<Response> };
}

export interface Env {
  CODE_REGISTRY: RegistryNamespace;
}

const MAX_BODY_BYTES = 4_096;

const ROUTES = new Set(['/nas', '/codes', '/codes/lookup']);

const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': PREFLIGHT_MAX_AGE,
};

async function route(request: Request, env: Env): Promise<Response> {
  if (!ROUTES.has(new URL(request.url).pathname)) return json(404, { error: 'not found' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
  if (request.method !== 'POST') {
    const response = json(405, { error: 'method not allowed' });
    response.headers.set('Allow', 'POST, OPTIONS');
    return response;
  }
  const body = await boundedBody(request);
  if (body === null) return json(413, { error: 'body too large' });
  const headers = new Headers(request.headers);
  headers.delete('Content-Length');
  const registry = env.CODE_REGISTRY;
  return registry.get(registry.idFromName('registry')).fetch(new Request(request.url, { method: 'POST', headers, body }));
}

/** The body's bytes, counted as they stream in; null once they pass `MAX_BODY_BYTES`. */
async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const answer = await route(request, env);
    // A Durable Object's response has immutable headers; copy it to add CORS.
    const response = new Response(answer.body, answer);
    for (const [name, value] of Object.entries(corsHeaders(request.headers.get('Origin')))) response.headers.set(name, value);
    return response;
  },
};
