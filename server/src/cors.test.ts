import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { corsHeaders } from './cors';
import { createServer } from './http';

describe('corsHeaders', () => {
  it.each(['https://bluray-web.pages.dev', 'https://fix-x.bluray-web.pages.dev', 'http://localhost:4173', 'http://localhost:5173'])(
    'echoes the allowed origin %s',
    (origin) => {
      expect(corsHeaders(origin)['Access-Control-Allow-Origin']).toBe(origin);
    },
  );

  it.each([['https://evil.pages.dev'], ['https://bluray-web.pages.dev.evil.com'], [undefined]])(
    'gives no Allow-Origin to %s',
    (origin) => {
      expect(corsHeaders(origin)).not.toHaveProperty('Access-Control-Allow-Origin');
    },
  );

  it.each([['https://bluray-web.pages.dev'], ['https://evil.pages.dev'], [undefined]])('always sets Vary and CORP (%s)', (origin) => {
    const headers = corsHeaders(origin);
    expect(headers['Vary']).toBe('Origin');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });
});

describe('createServer', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start(): Promise<string> {
    const server = createServer([]);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('answers GET /api/health', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'https://bluray-web.pages.dev' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://bluray-web.pages.dev');
    expect(res.headers.get('vary')).toBe('Origin');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('answers preflights', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/x`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4173');
    expect(res.headers.get('access-control-max-age')).toBe('600');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE');
  });

  it('answers 404 JSON when no handler matches', async () => {
    const base = await start();
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });
});
