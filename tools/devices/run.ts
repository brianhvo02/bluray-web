/**
 * Drives Safari on an iPhone, iPad or iOS Simulator through Appium's XCUITest driver (W3C WebDriver over HTTP;
 * no client library; the session itself is session.ts). Spec: docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md
 * §4.5. Setup: README.md here.
 *
 *   npx tsx tools/devices/run.ts --device <udid|"sim:iPhone 17"> --url <url> [step …]
 *
 * Steps run in the order they are given, after the URL opens:
 *   --until <js-expression>   poll until the expression is truthy (--timeout ms applies; default 60000)
 *   --tap x,y                 tap at page (CSS viewport) coordinates, as a real touch (it counts as a user gesture)
 *   --tap-on <css selector>   tap the centre of the first visible element the selector matches
 *   --swipe x1,y1,x2,y2       drag a finger between two page points over 300 ms, as a person scrolls
 *   --wait <ms>               sleep
 *   --screenshot <out.png>    the device screen
 *   --telemetry <out.json>    window.__blurayTelemetry (the page needs ?telemetry=1)
 *   --eval <js-expression>    print the expression's value as JSON (a promise is awaited)
 * and at the end:
 *   --console <out.txt>       Safari's console log for the whole run
 * Other options:
 *   --call-timeout <ms>       the longest one WebDriver call may take (default 120000, or $DEVICE_CALL_TIMEOUT_MS)
 *
 * A lost device, Appium or WebDriverAgent fails the run at once ("device disconnected or session lost"), and so does a
 * reload of the opened page ("page reloaded (possible memory kill)"), instead of waiting out a step's timeout.
 *
 * Without a running Appium at $APPIUM_URL (default http://127.0.0.1:4723) it starts the local one from
 * $APPIUM_HOME (default .cache/appium) and stops it afterwards.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DeviceSession, write, type DeviceTarget } from './session';

export { DeviceSession, DeviceLostError, PageReloadedError, write, type DeviceTarget } from './session';

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const APPIUM_HOME = process.env.APPIUM_HOME ?? resolve(REPO, '.cache/appium');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    const r = await fetch(`${APPIUM_URL}/status`, { signal: AbortSignal.timeout(5000) });
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

/** Appium capabilities for Safari on `target`. Real devices take WebDriverAgent's signing from the environment (README.md). */
export function safariCaps(target: DeviceTarget): Record<string, unknown> {
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
    const team = process.env.DEVICE_TEAM_ID;
    if (team) Object.assign(caps, { 'appium:xcodeOrgId': team, 'appium:xcodeSigningId': 'Apple Development', 'appium:allowProvisioningDeviceRegistration': true });
    if (process.env.WDA_BUNDLE_ID) caps['appium:updatedWDABundleId'] = process.env.WDA_BUNDLE_ID;
  }
  return caps;
}

type Step = { kind: 'until' | 'tap' | 'tap-on' | 'swipe' | 'wait' | 'screenshot' | 'telemetry' | 'eval'; arg: string };

export interface Options {
  device: string;
  url: string;
  timeoutMs: number;
  callTimeoutMs: number;
  console: string | null;
  steps: Step[];
}

const STEP_FLAGS = new Set(['until', 'tap', 'tap-on', 'swipe', 'wait', 'screenshot', 'telemetry', 'eval']);
const OPTION_FLAGS = new Set(['device', 'url', 'timeout', 'call-timeout', 'console']);
const USAGE =
  'usage: run.ts --device <udid|"sim:<name>"> --url <url> [--until js] [--tap x,y] [--tap-on selector] [--swipe x1,y1,x2,y2] [--wait ms] [--screenshot out.png] [--telemetry out.json] [--eval js] [--console out.txt] [--timeout ms] [--call-timeout ms]';

/** A positive whole number of milliseconds, or an error naming the flag. */
export function parseMs(flag: string, value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n <= 0) throw new Error(`${flag} ${value}: expected a positive number of milliseconds`);
  return n;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Options {
  const callDefault = env.DEVICE_CALL_TIMEOUT_MS ? parseMs('DEVICE_CALL_TIMEOUT_MS', env.DEVICE_CALL_TIMEOUT_MS) : 120_000;
  const o: Options = { device: '', url: '', timeoutMs: 60_000, callTimeoutMs: callDefault, console: null, steps: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i];
    const flag = arg.startsWith('--') ? arg.slice(2) : '';
    if (!OPTION_FLAGS.has(flag) && !STEP_FLAGS.has(flag)) throw new Error(`unknown option ${arg}\n${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (flag === 'device') o.device = value;
    else if (flag === 'url') o.url = value;
    else if (flag === 'timeout') o.timeoutMs = parseMs('--timeout', value);
    else if (flag === 'call-timeout') o.callTimeoutMs = parseMs('--call-timeout', value);
    else if (flag === 'console') o.console = value;
    else {
      if (flag === 'wait') parseMs('--wait', value);
      if (flag === 'tap' && !/^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(value)) throw new Error(`--tap ${value}: expected x,y`);
      o.steps.push({ kind: flag as Step['kind'], arg: value });
    }
  }
  if (!o.device || !o.url) throw new Error(USAGE);
  return o;
}

async function runStep(session: DeviceSession, step: Step, timeoutMs: number): Promise<void> {
  switch (step.kind) {
    case 'until':
      await session.until(step.arg, timeoutMs);
      return;
    case 'tap': {
      const [x, y] = step.arg.split(',').map(Number);
      await session.tap(x, y);
      return;
    }
    case 'tap-on': {
      const p = await session.locate(step.arg);
      await session.tap(p.x, p.y);
      return;
    }
    case 'swipe': {
      const [x1, y1, x2, y2] = step.arg.split(',').map(Number);
      await session.swipe({ x: x1!, y: y1! }, { x: x2!, y: y2! });
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
export async function withDevice<T>(device: string, body: (session: DeviceSession) => Promise<T>, callTimeoutMs?: number): Promise<T> {
  const target = await resolveDevice(device);
  const stopAppium = await ensureAppium();
  try {
    const session = await DeviceSession.start(target, { appiumUrl: APPIUM_URL, callTimeoutMs }, safariCaps(target));
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
  await withDevice(
    o.device,
    async (session) => {
      await session.open(o.url);
      try {
        for (const step of o.steps) {
          console.error(`· ${step.kind} ${step.arg}`);
          await runStep(session, step, o.timeoutMs);
        }
      } finally {
        if (o.console) write(o.console, `${(await session.consoleLog().catch((e: unknown) => [`(console log unavailable: ${String(e)})`])).join('\n')}\n`);
      }
    },
    o.callTimeoutMs,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
