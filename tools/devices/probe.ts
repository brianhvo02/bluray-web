/**
 * Runs the device probe (probe.html, src/probe/) on an iPhone, iPad or Simulator against a disc on the development disc
 * server, and prints and saves the results.
 *
 *   npx tsx tools/devices/probe.ts --device <udid|"sim:iPhone 17"> --server <origin> --token <token> --disc <name>
 *     [--out results.json] [--screenshot probe.png]
 *
 * `--server` is the disc server's origin as the device reaches it (https://<lan-ip>:8443 for a real device,
 * http://127.0.0.1:8080 is enough for the Simulator); `--disc` is the disc folder's name as the server lists it.
 * Over HTTPS with a mkcert certificate, run with NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" so this script
 * can read the server's disc list too.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMs, withDevice, write } from './run';

interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProbeOptions {
  device: string;
  server: string;
  token: string;
  disc: string;
  out: string | null;
  screenshot: string | null;
  callTimeoutMs: number | undefined;
}

const USAGE = 'usage: probe.ts --device <udid|"sim:<name>"> --server <origin> --token <token> --disc <name> [--out results.json] [--screenshot out.png] [--call-timeout ms]';

export function parseArgs(argv: readonly string[]): ProbeOptions {
  const o: ProbeOptions = { device: '', server: '', token: '', disc: '', out: null, screenshot: null, callTimeoutMs: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i];
    const flag = arg.startsWith('--') ? arg.slice(2) : '';
    if (!['device', 'server', 'token', 'disc', 'out', 'screenshot', 'call-timeout'].includes(flag)) throw new Error(`unknown option ${arg}\n${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (flag === 'device' || flag === 'server' || flag === 'token' || flag === 'disc') o[flag] = value;
    else if (flag === 'out' || flag === 'screenshot') o[flag] = value;
    else o.callTimeoutMs = parseMs('--call-timeout', value);
  }
  if (!o.device || !o.server || !o.token || !o.disc) throw new Error(USAGE);
  o.server = o.server.replace(/\/+$/, '');
  return o;
}

async function discUrl(o: ProbeOptions): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${o.server}/discs`, { headers: { Authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`could not reach ${o.server}/discs (${String(err)}); over HTTPS set NODE_EXTRA_CA_CERTS to mkcert's rootCA.pem`);
  }
  if (!response.ok) throw new Error(`${o.server}/discs answered ${response.status}`);
  const discs = (await response.json()) as Array<{ id: string; name: string }>;
  const disc = discs.find((d) => d.name === o.disc);
  if (!disc) throw new Error(`the server has no disc named "${o.disc}" (it has: ${discs.map((d) => d.name).join(', ')})`);
  return `${o.server}/discs/${encodeURIComponent(disc.id)}`;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const disc = await discUrl(o);
  const url = `${o.server}/probe.html?disc=${encodeURIComponent(disc)}&token=${encodeURIComponent(o.token)}`;
  const report = await withDevice(o.device, async (session) => {
    await session.open(url);
    await session.until('window.__probeResults', 90_000); // fails at once on a reload (memory kill) or a lost device
    if (o.screenshot) await session.screenshot(o.screenshot);
    const probe = await session.evaluate<{ userAgent: string; results?: ProbeResult[]; error?: string }>('window.__probeResults');
    return { device: session.target.simulator ? `Simulator: ${session.target.name}` : 'real device', route: 'server', disc: o.disc, date: new Date().toISOString(), ...probe };
  }, o.callTimeoutMs);
  if (o.out) write(o.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(report.userAgent);
  if (report.error) {
    console.log(`probe failed: ${report.error}`);
    process.exitCode = 1;
    return;
  }
  for (const r of report.results ?? []) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(22)} ${r.detail}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
