/**
 * bluray-rendezvous: turns a pairing code into "this NAS and how to reach it".
 * The NAS registers its key (`POST /nas`) and signed code hashes (`POST /codes`, server to server), and unregisters
 * a code it no longer needs (`DELETE /codes`, signed);
 * the app looks a typed code up (`POST /codes/lookup`, CORS for the app's origins).
 * WebRTC signalling: the NAS (`GET /signal/nas?nasId=`) and devices (`GET /signal/device?nasId=`) open WebSockets
 * to that NAS's `Signalling` object, after a per-client attempt limit the registry keeps.
 */
import { PREFLIGHT_MAX_AGE, corsHeaders } from '../../src/engine/disc/cors-policy';
import { INTERNAL, REGISTRY_NAME, json } from './code-registry';
import { isNasId } from './protocol';

export { CodeRegistry } from './code-registry';
export { Signalling } from './signalling';

/** The part of `DurableObjectNamespace` the Worker uses. */
export interface RegistryNamespace {
  idFromName(name: string): object;
  get(id: object): { fetch(request: Request): Promise<Response> };
}

export interface Env {
  CODE_REGISTRY: RegistryNamespace;
  SIGNALLING: RegistryNamespace;
}

const MAX_BODY_BYTES = 4_096;

const ROUTES = new Set(['/nas', '/codes', '/codes/lookup']);
const SIGNAL_ROUTES = new Set(['/signal/nas', '/signal/device']);

const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': PREFLIGHT_MAX_AGE,
};

async function route(request: Request, env: Env): Promise<Response> {
  if (!ROUTES.has(new URL(request.url).pathname)) return json(404, { error: 'not found' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
  const path = new URL(request.url).pathname;
  // DELETE /codes is the NAS unregistering a code, server to server (no CORS preflight allows it)
  if (request.method !== 'POST' && !(request.method === 'DELETE' && path === '/codes')) {
    const response = json(405, { error: 'method not allowed' });
    response.headers.set('Allow', path === '/codes' ? 'POST, DELETE, OPTIONS' : 'POST, OPTIONS');
    return response;
  }
  const body = await boundedBody(request);
  if (body === null) return json(413, { error: 'body too large' });
  const headers = new Headers(request.headers);
  headers.delete('Content-Length');
  const registry = env.CODE_REGISTRY;
  return registry.get(registry.idFromName(REGISTRY_NAME)).fetch(new Request(request.url, { method: request.method, headers, body }));
}

/**
 * A signalling WebSocket upgrade: checked, counted against the client's attempts, then handed to the NAS's
 * Signalling object. Its 101 response goes back as it is (copying it would drop the socket).
 */
async function signal(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    const response = json(405, { error: 'method not allowed' });
    response.headers.set('Allow', 'GET');
    return response;
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'expected a WebSocket upgrade' });
  const nasId = new URL(request.url).searchParams.get('nasId');
  if (!isNasId(nasId)) return json(400, { error: 'bad request' });
  const registry = env.CODE_REGISTRY;
  const attempt = await registry.get(registry.idFromName(REGISTRY_NAME)).fetch(
    new Request(`https://registry.internal${INTERNAL.signalAttempt}`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') ?? '' },
    }),
  );
  await attempt.body?.cancel();
  if (attempt.status !== 204) return json(429, { error: 'too many requests' });
  const signalling = env.SIGNALLING;
  return signalling.get(signalling.idFromName(nasId)).fetch(request);
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
    if (SIGNAL_ROUTES.has(new URL(request.url).pathname)) return signal(request, env);
    const answer = await route(request, env);
    // A Durable Object's response has immutable headers; copy it to add CORS.
    const response = new Response(answer.body, answer);
    for (const [name, value] of Object.entries(corsHeaders(request.headers.get('Origin')))) response.headers.set(name, value);
    return response;
  },
};
