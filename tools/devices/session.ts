/**
 * One Safari session on an iPhone, iPad or Simulator through Appium's XCUITest driver, spoken as W3C WebDriver with
 * `fetch`. Every call has a timeout; a lost device or session fails at once (`DeviceLostError`) instead of polling to
 * a step's timeout, and a page that reloads under a run (a memory kill, on iOS) is reported as such (`PageReloadedError`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const SCRIPT_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DeviceTarget {
  readonly udid: string;
  readonly simulator: boolean;
  readonly name: string;
}

export interface SessionOptions {
  /** Appium's URL, e.g. http://127.0.0.1:4723. */
  readonly appiumUrl: string;
  /** The longest any one WebDriver call may take (default 120 s; it must exceed the 60 s async script timeout). */
  readonly callTimeoutMs?: number;
  /** Creating the session, which may build WebDriverAgent (default 11 min). */
  readonly startTimeoutMs?: number;
}

/** The device, Appium or WebDriverAgent went away, or the session ended: nothing later in the run can work. */
export class DeviceLostError extends Error {
  constructor(detail: string) {
    super(`device disconnected or session lost: ${detail}`);
    this.name = 'DeviceLostError';
  }
}

/** The page the run opened is gone: it reloaded, which on iOS usually means the tab was killed for memory. */
export class PageReloadedError extends Error {
  constructor(during: string) {
    super(`page reloaded (possible memory kill) during ${during}`);
    this.name = 'PageReloadedError';
  }
}

/** A WebDriver error the run may survive (a script exception, an element not found yet). */
export class WebDriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WebDriverError';
  }
}

/** WebDriver error codes after which the session is unusable. */
const LOST_CODES = new Set(['invalid session id', 'session not created']);
/** Messages Appium passes on when WebDriverAgent, the inspector connection or the device went away. */
const LOST_MESSAGE = /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|Could not proxy command to the remote server|WebDriverAgent.*(crash|not running|exited|terminated)|device.*(not found|disconnected|unpaired)|Remote debugger.*(disconnect|not connected)/i;
/** Codes after which the web page may only have moved to another context (Safari swapped its web view). */
const WINDOW_CODES = new Set(['no such window', 'no such context']);
/** Codes that come from the page's own script; anything else from an in-page command makes us look for the page. */
const SCRIPT_CODES = new Set(['javascript error', 'script timeout']);

/** Maps a failed HTTP answer to the error the run should see. */
export function classifyAnswer(status: number, code: string | undefined, message: string): Error {
  if ((code && LOST_CODES.has(code)) || LOST_MESSAGE.test(message)) return new DeviceLostError(message || code || `HTTP ${status}`);
  return new WebDriverError(code ?? `HTTP ${status}`, message || code || `HTTP ${status}`);
}

/** Maps a fetch that threw (no answer at all) to the error the run should see. */
export function classifyFailure(err: unknown, what: string, timeoutMs: number): Error {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new DeviceLostError(`no answer to ${what} in ${timeoutMs} ms`);
  const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
  return new DeviceLostError(`${what}: ${cause}`);
}

/** The page asked for and the page loaded are the same document (ignoring the fragment; the page may rewrite it). */
function sameDocument(loaded: string, asked: string): boolean {
  try {
    const a = new URL(loaded);
    const b = new URL(asked);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class DeviceSession {
  private webview: string | null = null;
  /** Set on the page after each `open`; its absence means the page was reloaded. */
  private marker: string | null = null;
  private readonly callTimeoutMs: number;

  private constructor(
    private readonly base: string,
    readonly target: DeviceTarget,
    options: SessionOptions,
  ) {
    this.callTimeoutMs = options.callTimeoutMs ?? 120_000;
  }

  static async start(target: DeviceTarget, options: SessionOptions, caps: Record<string, unknown>): Promise<DeviceSession> {
    const startTimeoutMs = options.startTimeoutMs ?? 660_000;
    const url = `${options.appiumUrl.replace(/\/+$/, '')}/session`;
    let r: Response;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilities: { alwaysMatch: caps } }),
        signal: AbortSignal.timeout(startTimeoutMs),
      });
    } catch (err) {
      throw classifyFailure(err, 'starting the session', startTimeoutMs);
    }
    const body = (await r.json().catch(() => ({ value: {} }))) as { value: { sessionId?: string; message?: string } };
    if (!r.ok || !body.value.sessionId) throw new Error(`Appium could not start Safari on ${target.name}: ${body.value.message ?? r.status}`);
    const session = new DeviceSession(`${url}/${body.value.sessionId}`, target, options);
    await session.call('POST', '/timeouts', { script: SCRIPT_TIMEOUT_MS });
    return session;
  }

  private async call<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const what = `${method} ${path}`;
    let r: Response;
    let text: string;
    try {
      r = await fetch(`${this.base}${path}`, {
        method,
        headers: payload === undefined ? {} : { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.callTimeoutMs),
      });
      text = await r.text();
    } catch (err) {
      throw classifyFailure(err, what, this.callTimeoutMs);
    }
    let value: unknown;
    try {
      value = (JSON.parse(text) as { value?: unknown }).value;
    } catch {
      value = undefined;
    }
    if (!r.ok) {
      const v = (value ?? {}) as { error?: string; message?: string };
      throw classifyAnswer(r.status, v.error, `${what}: ${v.message ?? text.slice(0, 200)}`);
    }
    return value as T;
  }

  /** Switches to Safari's current web view; true when it differs from the one in use. */
  private async enterWebview(): Promise<boolean> {
    const contexts = await this.call<string[]>('GET', '/contexts');
    const webview = contexts.filter((c) => c.startsWith('WEBVIEW')).pop();
    if (!webview) throw new DeviceLostError('Safari has no web page (Safari quit, crashed or was killed)');
    const changed = webview !== this.webview;
    await this.call('POST', '/context', { name: webview });
    this.webview = webview;
    return changed;
  }

  /**
   * A command in the page. When it fails for a reason other than the page's own script, looks for the page: none means
   * Safari is gone (Appium then answers e.g. "Missing parameter: appIdKey"), a new web view is followed once.
   */
  private async inPage<T>(method: string, path: string, payload: unknown): Promise<T> {
    try {
      return await this.call<T>(method, path, payload);
    } catch (err) {
      if (!(err instanceof WebDriverError) || SCRIPT_CODES.has(err.code)) throw err;
      const moved = await this.enterWebview(); // throws DeviceLostError when Safari has no page at all
      if (moved) return this.call<T>(method, path, payload);
      if (WINDOW_CODES.has(err.code)) throw new DeviceLostError(err.message);
      throw err;
    }
  }

  async open(url: string): Promise<void> {
    // Safari may answer the navigation before the new document has replaced the old one (even one at the same URL):
    // flag the old document, and mark only a loaded document without the flag
    if (this.webview) await this.evaluate('(window.__runLeaving = true)').catch(() => undefined);
    await this.call('POST', '/url', { url });
    await this.enterWebview();
    const deadline = Date.now() + this.callTimeoutMs;
    for (;;) {
      const state = await this.evaluate<{ ready: string; href: string; old: boolean }>('({ ready: document.readyState, href: location.href, old: window.__runLeaving === true })').catch((err: unknown) => {
        if (err instanceof WebDriverError) return { ready: 'loading', href: '', old: false };
        throw err;
      });
      if (state.ready === 'complete' && !state.old && sameDocument(state.href, url)) break;
      if (Date.now() > deadline) throw new Error(`${url} did not finish loading in ${this.callTimeoutMs} ms (at ${state.href || 'nothing'}, ${state.ready})`);
      await sleep(200);
    }
    this.marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.evaluate(`(window.__runMarker = ${JSON.stringify(this.marker)}, true)`);
  }

  /** Runs `return (<expression>)` in the page. */
  async evaluate<T>(expression: string): Promise<T> {
    return this.inPage<T>('POST', '/execute/sync', { script: `return (${expression});`, args: [] });
  }

  /** Like `evaluate`, but waits for a promise the expression returns. */
  async evaluateAsync<T>(expression: string): Promise<T> {
    const script =
      `const done = arguments[arguments.length - 1];` +
      ` Promise.resolve().then(() => (${expression})).then((value) => done({ value }), (err) => done({ error: String(err) }));`;
    const r = await this.inPage<{ value?: T; error?: string }>('POST', '/execute/async', { script, args: [] });
    if (r.error !== undefined) throw new Error(`${expression}: ${r.error}`);
    return r.value as T;
  }

  /**
   * Polls until `expression` is truthy. Script errors keep it polling (the page may still be loading); a lost device
   * fails at once, and so does a reload of the page `open` loaded.
   */
  async until(expression: string, timeoutMs: number, pollMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const marker = this.marker === null ? 'true' : `window.__runMarker === ${JSON.stringify(this.marker)}`;
    const probe = `(() => { const same = ${marker}; try { return { same, ok: !!(${expression}) }; } catch (e) { return { same, ok: false, error: String(e) }; } })()`;
    let last = 'not run';
    for (;;) {
      try {
        const r = await this.evaluate<{ same: boolean; ok: boolean; error?: string }>(probe);
        if (!r.same) throw new PageReloadedError(`--until ${expression}`);
        if (r.ok) return;
        last = r.error ?? 'falsy';
      } catch (err) {
        if (!(err instanceof WebDriverError)) throw err;
        last = err.message;
      }
      if (Date.now() + pollMs > deadline) throw new Error(`--until ${expression}: still ${last} after ${timeoutMs} ms`);
      await sleep(pollMs);
    }
  }

  /**
   * Runs `touch` in the native context with a function from page (CSS viewport) coordinates to screen points. Safari's
   * toolbars move the page on screen, so it first calibrates: a probe element fixed at the viewport's corner is found
   * in the accessibility tree, which gives the page's offset and scale on screen.
   */
  private async onScreen(touch: (at: (x: number, y: number) => { x: number; y: number }) => Promise<void>): Promise<void> {
    const id = `devices-calibrate-${Date.now()}`;
    await this.evaluate(
      `(() => { const e = document.createElement('div'); e.id = ${JSON.stringify(id)}; e.setAttribute('role', 'button'); e.setAttribute('aria-label', ${JSON.stringify(id)});` +
        ` e.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;opacity:0.02;z-index:2147483647;pointer-events:none'; document.body.append(e); return true; })()`,
    );
    try {
      await this.call('POST', '/context', { name: 'NATIVE_APP' });
      let rect: Rect | null = null;
      for (let i = 0; i < 10 && !rect; i++) {
        try {
          const el = await this.call<Record<string, string>>('POST', '/element', { using: 'accessibility id', value: id });
          rect = await this.call<Rect>('GET', `/element/${el[ELEMENT]}/rect`);
        } catch (err) {
          if (!(err instanceof WebDriverError)) throw err;
          await sleep(300);
        }
      }
      if (!rect) throw new Error('could not find the calibration element on screen');
      const found = rect;
      const scale = found.width / 100;
      await touch((x, y) => ({ x: found.x + x * scale, y: found.y + y * scale }));
    } finally {
      await this.enterWebview();
      await this.evaluate(`(document.getElementById(${JSON.stringify(id)})?.remove(), true)`).catch(() => undefined);
    }
  }

  /** A native touch at page (CSS viewport) coordinates. */
  async tap(x: number, y: number): Promise<void> {
    await this.onScreen((at) => this.call('POST', '/execute/sync', { script: 'mobile: tap', args: [at(x, y)] }));
  }

  /**
   * A native finger drag from one page point to another over `ms`, as a person scrolls: Safari scrolls the page itself
   * (outside the page's script), unlike `scrollTo`.
   */
  async swipe(from: { x: number; y: number }, to: { x: number; y: number }, ms = 300): Promise<void> {
    await this.onScreen(async (at) => {
      const a = at(from.x, from.y);
      const b = at(to.x, to.y);
      await this.call('POST', '/execute/sync', { script: 'mobile: dragFromToForDuration', args: [{ fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, duration: ms / 1000 }] });
    });
  }

  /** The centre (page coordinates) of the first visible element `selector` matches. */
  async locate(selector: string): Promise<{ x: number; y: number }> {
    const found = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length > 0);` +
        ` if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!found) throw new Error(`nothing visible matches ${selector}`);
    return found;
  }

  async screenshot(out: string): Promise<void> {
    const b64 = await this.call<string>('GET', '/screenshot');
    write(out, Buffer.from(b64, 'base64'));
  }

  async consoleLog(): Promise<string[]> {
    const entries = await this.call<Array<{ timestamp: number; level: string; message: string }>>('POST', '/se/log', { type: 'safariConsole' });
    return entries.map((e) => {
      let text = e.message;
      try {
        text = (JSON.parse(e.message) as { text?: string }).text ?? text; // the inspector's console message, as JSON
      } catch {
        // already plain text
      }
      return `${new Date(e.timestamp).toISOString()} ${e.level} ${text}`;
    });
  }

  async close(): Promise<void> {
    await fetch(this.base, { method: 'DELETE', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }
}

export function write(out: string, data: string | Uint8Array): void {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, data);
}
