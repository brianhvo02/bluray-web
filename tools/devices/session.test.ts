import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs as parseProbeArgs } from './probe';
import { parseArgs } from './run';
import { DeviceLostError, DeviceSession, PageReloadedError, WebDriverError, classifyAnswer } from './session';

type Handler = (method: string, path: string, body: unknown, res: ServerResponse) => void | 'hang';

const target = { udid: 'SIM', simulator: true, name: 'fake' };
let server: Server | null = null;

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ value }));
}

/** A fake Appium: session creation, timeouts and contexts are answered; everything else goes to `handler`. */
async function fakeAppium(handler: Handler, contexts: () => string[] = () => ['NATIVE_APP', 'WEBVIEW_1']): Promise<string> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const path = (req.url ?? '/').replace(/^\/session\/s1/, '');
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      if (req.method === 'POST' && req.url === '/session') return reply(res, 200, { sessionId: 's1', capabilities: {} });
      if (path === '/timeouts' || path === '/url' || path === '/context' || req.method === 'DELETE') return reply(res, 200, null);
      if (path === '/contexts') return reply(res, 200, contexts());
      if (path === '/execute/sync' && script(body).includes('document.readyState')) return reply(res, 200, { ready: 'complete', href: 'http://page/', old: false });
      if (handler(req.method ?? 'GET', path, body, res) === 'hang') return; // never answers
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

const script = (body: unknown): string => (body as { script: string }).script;

/** Answers the marker set by `open`, then the `until` probe with `results` in turn. */
function page(results: Array<{ same: boolean; ok: boolean; error?: string } | { status: number; error: string; message: string }>): Handler {
  let i = 0;
  return (_m, path, body, res) => {
    if (path !== '/execute/sync') return reply(res, 404, { error: 'unknown command', message: path });
    if (script(body).includes('__runMarker = "')) return reply(res, 200, true);
    const r = results[Math.min(i++, results.length - 1)];
    if ('status' in r) return reply(res, r.status, { error: r.error, message: r.message });
    reply(res, 200, r);
  };
}

async function opened(url: string, callTimeoutMs = 2000): Promise<DeviceSession> {
  const s = await DeviceSession.start(target, { appiumUrl: url, callTimeoutMs }, {});
  await s.open('http://page/');
  return s;
}

describe('DeviceSession failure classification', () => {
  it('until keeps polling through script errors and resolves when the expression turns true', async () => {
    const url = await fakeAppium(page([{ same: true, ok: false, error: 'ReferenceError: x' }, { status: 500, error: 'javascript error', message: 'boom' }, { same: true, ok: true }]));
    await expect((await opened(url)).until('x', 5000, 10)).resolves.toBeUndefined();
  });

  it('an invalid session fails at once, not at the step timeout', async () => {
    const url = await fakeAppium(page([{ status: 404, error: 'invalid session id', message: 'A session is either terminated or not started' }]));
    const s = await opened(url);
    const started = Date.now();
    await expect(s.until('x', 60_000, 10)).rejects.toThrow(/device disconnected or session lost/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a WebDriverAgent crash relayed by Appium is a lost device', async () => {
    const url = await fakeAppium(page([{ status: 500, error: 'unknown error', message: 'Could not proxy command to the remote server. Original error: socket hang up' }]));
    await expect((await opened(url)).until('x', 60_000, 10)).rejects.toBeInstanceOf(DeviceLostError);
  });

  it('Appium gone (connection refused) is a lost device', async () => {
    const url = await fakeAppium(page([{ same: true, ok: false }]));
    const s = await opened(url);
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    await expect(s.until('x', 60_000, 10)).rejects.toThrow(/device disconnected or session lost: .*(ECONN(REFUSED|RESET)|UND_ERR_SOCKET)/); // Linux's undici reports the dropped socket
  });

  it('a call with no answer times out as a lost device', async () => {
    let n = 0;
    const url = await fakeAppium((_m, _p, body, res) => {
      if (script(body).includes('__runMarker = "')) return reply(res, 200, true);
      n++;
      return 'hang';
    });
    const s = await opened(url, 200);
    await expect(s.until('x', 60_000, 10)).rejects.toThrow(/no answer to POST \/execute\/sync in 200 ms/);
    expect(n).toBe(1);
  });

  it('a reloaded page (marker gone) is reported as a possible memory kill', async () => {
    const url = await fakeAppium(page([{ same: true, ok: false }, { same: false, ok: false }]));
    const err = await (await opened(url)).until('window.ready', 60_000, 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PageReloadedError);
    expect((err as Error).message).toBe('page reloaded (possible memory kill) during --until window.ready');
  });

  it('follows Safari to a new web view once, then retries', async () => {
    let webviews = ['NATIVE_APP', 'WEBVIEW_1'];
    let calls = 0;
    const url = await fakeAppium(
      (_m, _p, body, res) => {
        if (script(body).includes('__runMarker = "')) return reply(res, 200, true);
        if (++calls === 1) {
          webviews = ['NATIVE_APP', 'WEBVIEW_2'];
          return reply(res, 404, { error: 'no such window', message: 'window gone' });
        }
        reply(res, 200, 42);
      },
      () => webviews,
    );
    await expect((await opened(url)).evaluate('42')).resolves.toBe(42);
  });

  it('no such window with no new web view is a lost session', async () => {
    const url = await fakeAppium((_m, _p, body, res) => {
      if (script(body).includes('__runMarker = "')) return reply(res, 200, true);
      reply(res, 404, { error: 'no such window', message: 'window gone' });
    });
    await expect((await opened(url)).evaluate('1')).rejects.toBeInstanceOf(DeviceLostError);
  });

  it('Safari gone (Appium loses the page, only NATIVE_APP left) is a lost session at once', async () => {
    let contexts = ['NATIVE_APP', 'WEBVIEW_1'];
    const url = await fakeAppium(
      (_m, _p, body, res) => {
        if (script(body).includes('__runMarker = "')) return reply(res, 200, true);
        contexts = ['NATIVE_APP'];
        reply(res, 500, { error: 'unknown error', message: 'Missing parameter: appIdKey' });
      },
      () => contexts,
    );
    await expect((await opened(url)).until('x', 60_000, 10)).rejects.toThrow(/session lost: Safari has no web page/);
  });

  it('open marks only the new document, not the one it is leaving', async () => {
    const states = [
      { ready: 'complete', href: 'http://page/', old: true },
      { ready: 'loading', href: 'http://page/', old: false },
      { ready: 'complete', href: 'http://page/', old: false },
    ];
    let marked = -1;
    let polls = 0;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const path = (req.url ?? '/').replace(/^\/session\/s1/, '');
        if (req.method === 'POST' && req.url === '/session') return reply(res, 200, { sessionId: 's1' });
        if (path === '/contexts') return reply(res, 200, ['NATIVE_APP', 'WEBVIEW_1']);
        if (path !== '/execute/sync') return reply(res, 200, null);
        const s = script(JSON.parse(raw));
        if (s.includes('document.readyState')) return reply(res, 200, states[Math.min(polls++, states.length - 1)]);
        if (s.includes('__runMarker = "')) marked = polls;
        reply(res, 200, true);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const s = await DeviceSession.start(target, { appiumUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, {});
    await s.open('http://page/');
    expect(marked).toBe(3);
  });

  it('classifyAnswer keeps script errors survivable', () => {
    expect(classifyAnswer(500, 'javascript error', 'ReferenceError')).toBeInstanceOf(WebDriverError);
    expect(classifyAnswer(404, 'no such element', 'not found')).toBeInstanceOf(WebDriverError);
    expect(classifyAnswer(404, 'invalid session id', 'gone')).toBeInstanceOf(DeviceLostError);
    expect(classifyAnswer(500, 'unknown error', 'connect ECONNREFUSED 127.0.0.1:8100')).toBeInstanceOf(DeviceLostError);
  });
});

describe('argument parsing', () => {
  const base = ['--device', 'sim:iPhone 17', '--url', 'http://x/'];

  it('run.ts keeps steps in order and validates numbers', () => {
    const o = parseArgs([...base, '--tap', '10,20', '--wait', '500', '--until', 'true', '--timeout', '9000'], {});
    expect(o.steps.map((s) => s.kind)).toEqual(['tap', 'wait', 'until']);
    expect(o.timeoutMs).toBe(9000);
    expect(o.callTimeoutMs).toBe(120_000);
    expect(() => parseArgs([...base, '--timeout', 'soon'], {})).toThrow(/--timeout soon: expected a positive number/);
    expect(() => parseArgs([...base, '--timeout', 'NaN'], {})).toThrow(/expected a positive number/);
    expect(() => parseArgs([...base, '--call-timeout', '0'], {})).toThrow(/expected a positive number/);
    expect(() => parseArgs([...base, '--wait', '1.5s'], {})).toThrow(/--wait/);
    expect(() => parseArgs([...base, '--tap', '10'], {})).toThrow(/--tap 10: expected x,y/);
    expect(() => parseArgs([...base, '--bogus', '1'], {})).toThrow(/unknown option --bogus/);
    expect(() => parseArgs([...base, 'stray'], {})).toThrow(/unknown option stray/);
    expect(() => parseArgs(base, { DEVICE_CALL_TIMEOUT_MS: 'x' })).toThrow(/DEVICE_CALL_TIMEOUT_MS/);
  });

  it('probe.ts rejects unknown flags clearly', () => {
    const ok = ['--device', 'sim:iPhone 17', '--server', 'http://h:8080/', '--token', 't', '--disc', 'disc1'];
    expect(parseProbeArgs(ok).server).toBe('http://h:8080');
    expect(() => parseProbeArgs([...ok, '--timeout', '5'])).toThrow(/unknown option --timeout\nusage: probe\.ts/);
    expect(() => parseProbeArgs([...ok, 'disc2'])).toThrow(/unknown option disc2/);
    expect(() => parseProbeArgs(['--device', 'x'])).toThrow(/usage: probe\.ts/);
  });
});
