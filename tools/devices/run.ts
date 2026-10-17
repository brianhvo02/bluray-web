/**
 * Drives Safari on an iPhone, iPad or iOS Simulator through Appium's XCUITest driver (W3C WebDriver over HTTP;
 * no client library). Spec: docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md §4.5. Setup: README.md here.
 *
 *   npx tsx tools/devices/run.ts --device <udid|"sim:iPhone 17"> --url <url> [step …]
 *
 * Steps run in the order they are given, after the URL opens:
 *   --until <js-expression>   poll until the expression is truthy (--timeout ms applies; default 60000)
 *   --tap x,y                 tap at page (CSS viewport) coordinates, as a real touch (it counts as a user gesture)
 *   --tap-on <css selector>   tap the centre of the first visible element the selector matches
 *   --wait <ms>               sleep
 *   --screenshot <out.png>    the device screen
 *   --telemetry <out.json>    window.__blurayTelemetry (the page needs ?telemetry=1)
 *   --eval <js-expression>    print the expression's value as JSON (a promise is awaited)
 * and at the end:
 *   --console <out.txt>       Safari's console log for the whole run
 *
 * Without a running Appium at $APPIUM_URL (default http://127.0.0.1:4723) it starts the local one from
 * $APPIUM_HOME (default .cache/appium) and stops it afterwards.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const APPIUM_HOME = process.env.APPIUM_HOME ?? resolve(REPO, '.cache/appium');
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DeviceTarget {
  readonly udid: string;
  readonly simulator: boolean;
  readonly name: string;
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

/** `sim:<name>` picks the newest-runtime Simulator of that name and boots it; anything else is a real device's UDID. */
export async function resolveDevice(spec: string): Promise<DeviceTarget> {
  if (!spec.startsWith('sim:')) return { udid: spec, simulator: false, name: spec };
  const name = spec.slice(4);
  const { stdout } = await exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  const runtimes = (JSON.parse(stdout) as { devices: Record<string, SimDevice[]> }).devices;
  const found = Object.entries(runtimes)
    .filter(([runtime]) => runtime.includes('.iOS-'))
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    .flatMap(([, list]) => list)
    .find((d) => d.name === name && d.isAvailable);
  if (!found) throw new Error(`no available Simulator named "${name}" (xcrun simctl list devices available)`);
  if (found.state !== 'Booted') {
    await exec('xcrun', ['simctl', 'boot', found.udid]);
    await exec('xcrun', ['simctl', 'bootstatus', found.udid, '-b'], { timeout: 300_000 });
  }
  await exec('open', ['-a', 'Simulator']).catch(() => undefined); // the window is optional; automation works headless
  return { udid: found.udid, simulator: true, name };
}

async function appiumReady(): Promise<boolean> {
  try {
    const r = await fetch(`${APPIUM_URL}/status`);
    return r.ok && ((await r.json()) as { value?: { ready?: boolean } }).value?.ready === true;
  } catch {
    return false;
  }
}

/** Starts the local Appium unless one is already listening; the returned function stops what was started. */
export async function ensureAppium(): Promise<() => void> {
  if (await appiumReady()) return () => undefined;
  const port = new URL(APPIUM_URL).port || '4723';
  const bin = resolve(APPIUM_HOME, 'node_modules/.bin/appium');
  const child: ChildProcess = spawn(bin, ['--port', port, '--log-level', 'warn'], { env: { ...process.env, APPIUM_HOME }, stdio: ['ignore', 'inherit', 'inherit'] });
  let failed: Error | null = null;
  child.on('error', (err) => {
    failed = new Error(`could not start Appium (${bin}): ${err.message}; see tools/devices/README.md`);
  });
  for (let i = 0; i < 120 && !failed; i++) {
    if (await appiumReady()) return () => child.kill();
    await sleep(500);
  }
  child.kill();
  throw failed ?? new Error('Appium did not become ready in 60 s');
}

interface WireValue<T> {
  value: T;
}

export class DeviceSession {
  private webview: string | null = null;

  private constructor(
    private readonly base: string,
    readonly target: DeviceTarget,
  ) {}

  static async start(target: DeviceTarget): Promise<DeviceSession> {
    const caps: Record<string, unknown> = {
      platformName: 'iOS',
      browserName: 'Safari',
      'appium:automationName': 'XCUITest',
      'appium:udid': target.udid,
      'appium:newCommandTimeout': 600,
      'appium:wdaLaunchTimeout': 600_000,
      'appium:showSafariConsoleLog': true,
      'appium:safariIgnoreFraudWarning': true,
    };
    if (!target.simulator) {
      // Real devices: WebDriverAgent is signed with the user's personal team (README.md). Kept out of the repository.
      const team = process.env.DEVICE_TEAM_ID;
      if (team) Object.assign(caps, { 'appium:xcodeOrgId': team, 'appium:xcodeSigningId': 'Apple Development', 'appium:allowProvisioningDeviceRegistration': true });
      if (process.env.WDA_BUNDLE_ID) caps['appium:updatedWDABundleId'] = process.env.WDA_BUNDLE_ID;
    }
    const r = await fetch(`${APPIUM_URL}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capabilities: { alwaysMatch: caps } }) });
    const body = (await r.json()) as WireValue<{ sessionId?: string; message?: string }>;
    if (!r.ok || !body.value.sessionId) throw new Error(`Appium could not start Safari on ${target.name}: ${body.value.message ?? r.status}`);
    const session = new DeviceSession(`${APPIUM_URL}/session/${body.value.sessionId}`, target);
    await session.call('POST', '/timeouts', { script: 60_000 });
    return session;
  }

  private async call<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = (await r.json()) as WireValue<T & { error?: string; message?: string }>;
    if (!r.ok) throw new Error(`${method} ${path}: ${body.value?.message ?? r.status}`);
    return body.value;
  }

  async open(url: string): Promise<void> {
    await this.call('POST', '/url', { url });
    const contexts = await this.call<string[]>('GET', '/contexts');
    this.webview = contexts.filter((c) => c.startsWith('WEBVIEW')).pop() ?? null;
  }

  /** Runs `return (<expression>)` in the page. */
  async evaluate<T>(expression: string): Promise<T> {
    return this.call<T>('POST', '/execute/sync', { script: `return (${expression});`, args: [] });
  }

  /** Like `evaluate`, but waits for a promise the expression returns. */
  async evaluateAsync<T>(expression: string): Promise<T> {
    const script =
      `const done = arguments[arguments.length - 1];` +
      ` Promise.resolve().then(() => (${expression})).then((value) => done({ value }), (err) => done({ error: String(err) }));`;
    const r = await this.call<{ value?: T; error?: string }>('POST', '/execute/async', { script, args: [] });
    if (r.error !== undefined) throw new Error(`${expression}: ${r.error}`);
    return r.value as T;
  }

  async until(expression: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate<boolean>(`!!(${expression})`)) return;
        last = 'falsy';
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      await sleep(500);
    }
    throw new Error(`--until ${expression}: still ${last} after ${timeoutMs} ms`);
  }

  /**
   * A native touch at page (CSS viewport) coordinates. Safari's toolbars move the page on screen, so each tap first
   * calibrates: a probe element fixed at the viewport's corner is found in the accessibility tree, which gives the
   * page's offset and scale on screen.
   */
  async tap(x: number, y: number): Promise<void> {
    const id = `devices-calibrate-${Date.now()}`;
    await this.evaluate(
      `(() => { const e = document.createElement('div'); e.id = ${JSON.stringify(id)}; e.setAttribute('role', 'button'); e.setAttribute('aria-label', ${JSON.stringify(id)});` +
        ` e.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;opacity:0.02;z-index:2147483647;pointer-events:none'; document.body.append(e); return true; })()`,
    );
    let point: { x: number; y: number };
    try {
      await this.call('POST', '/context', { name: 'NATIVE_APP' });
      let rect: { x: number; y: number; width: number; height: number } | null = null;
      for (let i = 0; i < 10 && !rect; i++) {
        try {
          const el = await this.call<Record<string, string>>('POST', '/element', { using: 'accessibility id', value: id });
          rect = await this.call('GET', `/element/${el[ELEMENT]}/rect`);
        } catch {
          await sleep(300);
        }
      }
      if (!rect) throw new Error('could not find the calibration element on screen');
      const scale = rect.width / 100;
      point = { x: rect.x + x * scale, y: rect.y + y * scale };
      await this.call('POST', '/execute/sync', { script: 'mobile: tap', args: [point] });
    } finally {
      if (this.webview) await this.call('POST', '/context', { name: this.webview });
      await this.evaluate(`(document.getElementById(${JSON.stringify(id)})?.remove(), true)`).catch(() => undefined);
    }
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
    await fetch(this.base, { method: 'DELETE' }).catch(() => undefined);
  }
}

export function write(out: string, data: string | Uint8Array): void {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, data);
}

type Step = { kind: 'until' | 'tap' | 'tap-on' | 'wait' | 'screenshot' | 'telemetry' | 'eval'; arg: string };

interface Options {
  device: string;
  url: string;
  timeoutMs: number;
  console: string | null;
  steps: Step[];
}

const STEP_FLAGS = new Set(['until', 'tap', 'tap-on', 'wait', 'screenshot', 'telemetry', 'eval']);

function parseArgs(argv: readonly string[]): Options {
  const o: Options = { device: '', url: '', timeoutMs: 60_000, console: null, steps: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].replace(/^--/, '');
    const value = argv[++i];
    if (value === undefined) throw new Error(`${argv[i - 1]} needs a value`);
    if (flag === 'device') o.device = value;
    else if (flag === 'url') o.url = value;
    else if (flag === 'timeout') o.timeoutMs = Number(value);
    else if (flag === 'console') o.console = value;
    else if (STEP_FLAGS.has(flag)) o.steps.push({ kind: flag as Step['kind'], arg: value });
    else throw new Error(`unknown option ${argv[i - 1]}`);
  }
  if (!o.device || !o.url) throw new Error('usage: run.ts --device <udid|"sim:<name>"> --url <url> [--until js] [--tap x,y] [--tap-on selector] [--wait ms] [--screenshot out.png] [--telemetry out.json] [--eval js] [--console out.txt] [--timeout ms]');
  return o;
}

async function runStep(session: DeviceSession, step: Step, timeoutMs: number): Promise<void> {
  switch (step.kind) {
    case 'until':
      await session.until(step.arg, timeoutMs);
      return;
    case 'tap': {
      const [x, y] = step.arg.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--tap ${step.arg}: expected x,y`);
      await session.tap(x, y);
      return;
    }
    case 'tap-on': {
      const p = await session.locate(step.arg);
      await session.tap(p.x, p.y);
      return;
    }
    case 'wait':
      await sleep(Number(step.arg));
      return;
    case 'screenshot':
      await session.screenshot(step.arg);
      return;
    case 'telemetry':
      write(step.arg, `${JSON.stringify(await session.evaluate('window.__blurayTelemetry ?? null'), null, 2)}\n`);
      return;
    case 'eval':
      console.log(JSON.stringify(await session.evaluateAsync(step.arg)));
      return;
  }
}

/** Opens a session, runs `body`, and always closes the session (and an Appium it started). */
export async function withDevice<T>(device: string, body: (session: DeviceSession) => Promise<T>): Promise<T> {
  const target = await resolveDevice(device);
  const stopAppium = await ensureAppium();
  try {
    const session = await DeviceSession.start(target);
    try {
      return await body(session);
    } finally {
      await session.close();
    }
  } finally {
    stopAppium();
  }
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  await withDevice(o.device, async (session) => {
    await session.open(o.url);
    try {
      for (const step of o.steps) {
        console.error(`· ${step.kind} ${step.arg}`);
        await runStep(session, step, o.timeoutMs);
      }
    } finally {
      if (o.console) write(o.console, `${(await session.consoleLog().catch((e: unknown) => [`(console log unavailable: ${String(e)})`])).join('\n')}\n`);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
