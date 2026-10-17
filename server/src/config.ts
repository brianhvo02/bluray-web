export interface LibraryRoot {
  name: string;
  dir: string;
}

export interface Config {
  roots: LibraryRoot[];
  dataDir: string;
  port: number;
  /** Local time of the nightly rescan. */
  nightlyScanAt: { hour: number; minute: number };
  /** Pause between directory reads of a scan. */
  scanPauseMs: number;
  /** This server's API as devices reach it, registered with each pairing code. */
  publicBase: string;
  /** IP or hostname of the reverse proxy whose `X-Forwarded-For` is believed. */
  trustedProxy: string;
}

const DEFAULT_PUBLIC_BASE = 'https://mediaserver.tailnet-8e55.ts.net/bluray/api/';

/** Reads `LIBRARY_ROOTS` (comma-separated `name=dir`), `DATA_DIR`, `PORT`, `NIGHTLY_SCAN_AT` (`HH:MM`), `SCAN_PAUSE_MS`, `PUBLIC_BASE` and `TRUSTED_PROXY`. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const roots = (env.LIBRARY_ROOTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0 || eq === entry.length - 1) throw new Error(`LIBRARY_ROOTS entry "${entry}" is not name=dir`);
      return { name: entry.slice(0, eq), dir: entry.slice(eq + 1) };
    });
  const seen = new Set<string>();
  for (const { name } of roots) {
    if (seen.has(name)) throw new Error(`LIBRARY_ROOTS names "${name}" twice`);
    seen.add(name);
  }
  return { roots, dataDir: env.DATA_DIR ?? '/data', port: parsePort(env.PORT), nightlyScanAt: parseTime(env.NIGHTLY_SCAN_AT), scanPauseMs: parsePause(env.SCAN_PAUSE_MS), publicBase: parseBase(env.PUBLIC_BASE), trustedProxy: parseProxy(env.TRUSTED_PROXY) };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8080;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) throw new Error(`PORT "${value}" is not a port number`);
  return port;
}

function parseTime(value: string | undefined): { hour: number; minute: number } {
  if (value === undefined) return { hour: 4, minute: 0 };
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`NIGHTLY_SCAN_AT "${value}" is not HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parsePause(value: string | undefined): number {
  if (value === undefined) return 10;
  if (!/^\d+$/.test(value)) throw new Error(`SCAN_PAUSE_MS "${value}" is not a number of milliseconds`);
  return Number(value);
}

function parseBase(value: string | undefined): string {
  if (value === undefined) return DEFAULT_PUBLIC_BASE;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error(`PUBLIC_BASE "${value}" is not an http(s) URL`);
  return value;
}

function parseProxy(value: string | undefined): string {
  if (value === undefined) return 'caddy';
  if (!/^[A-Za-z0-9.:_-]+$/.test(value)) throw new Error(`TRUSTED_PROXY "${value}" is not an IP or hostname`);
  return value;
}
