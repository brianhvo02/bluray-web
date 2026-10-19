import { advertisable } from './rtc/public-address';

export interface LibraryRoot {
  name: string;
  dir: string;
  /** Roots sharing a group appear as one top-level folder named after it. */
  group?: string;
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
  /** The rendezvous Worker's base URL; unset (or empty) means codes aren't registered with it. */
  rendezvousUrl: string | undefined;
  /** `TMDB_API_KEY`; null (unset or empty) means AniList and TheDiscDB only. Never logged. */
  tmdbApiKey: string | null;
  /** `TITLE_LIBRARY`: who gets the title routes until the owner sets it. */
  titleLibrary: 'owners' | 'everyone';
  /** The WebRTC route, served while `rendezvousUrl` is set. */
  rtc: RtcConfig;
}

export interface RtcConfig {
  /** `RTC_PORT`: the one UDP port ICE uses, 47998 by default. */
  port: number;
  /** `RTC_LAN_ADDRESS`: the NAS's LAN IPv4, advertised next to its public address. */
  lanAddress?: string;
  /** `RTC_ADVERTISE` (tests): advertised instead of the public and LAN addresses, with no STUN discovery. */
  advertise?: string[];
}

const DEFAULT_PUBLIC_BASE = 'https://mediaserver.tailnet-8e55.ts.net/bluray/api/';

/** Reads `LIBRARY_ROOTS` (comma-separated `name=dir` or `name=dir@group`), `DATA_DIR`, `PORT`, `NIGHTLY_SCAN_AT` (`HH:MM`), `SCAN_PAUSE_MS`, `PUBLIC_BASE`, `TRUSTED_PROXY`, `RENDEZVOUS_URL`, `TMDB_API_KEY`, `TITLE_LIBRARY`, `RTC_PORT`, `RTC_LAN_ADDRESS` and `RTC_ADVERTISE`. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const roots = (env.LIBRARY_ROOTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0 || eq === entry.length - 1) throw new Error(`LIBRARY_ROOTS entry "${entry}" is not name=dir`);
      const rest = entry.slice(eq + 1);
      const at = rest.lastIndexOf('@');
      if (at < 0) return { name: entry.slice(0, eq), dir: rest };
      const group = rest.slice(at + 1);
      if (at === 0 || group === '') throw new Error(`LIBRARY_ROOTS entry "${entry}" is not name=dir`);
      return { name: entry.slice(0, eq), dir: rest.slice(0, at), group };
    });
  const seen = new Set<string>();
  for (const { name } of roots) {
    if (seen.has(name)) throw new Error(`LIBRARY_ROOTS names "${name}" twice`);
    seen.add(name);
  }
  for (const { group } of roots) {
    if (group !== undefined && seen.has(group)) throw new Error(`LIBRARY_ROOTS group "${group}" is also a root name`);
  }
  return { roots, dataDir: env.DATA_DIR ?? '/data', port: parsePort(env.PORT), nightlyScanAt: parseTime(env.NIGHTLY_SCAN_AT), scanPauseMs: parsePause(env.SCAN_PAUSE_MS), publicBase: parseBase(env.PUBLIC_BASE), trustedProxy: parseProxy(env.TRUSTED_PROXY), rendezvousUrl: parseRendezvous(env.RENDEZVOUS_URL), tmdbApiKey: env.TMDB_API_KEY?.trim() || null, titleLibrary: parseTitleLibrary(env.TITLE_LIBRARY), rtc: parseRtc(env) };
}

function parseRtc(env: Record<string, string | undefined>): RtcConfig {
  const rtc: RtcConfig = { port: 47998 };
  if (env.RTC_PORT !== undefined && env.RTC_PORT !== '') {
    const port = Number(env.RTC_PORT);
    if (!/^\d+$/.test(env.RTC_PORT) || port === 0 || port >= 65535) throw new Error(`RTC_PORT "${env.RTC_PORT}" is not a UDP port below 65535`);
    rtc.port = port;
  }
  if (env.RTC_LAN_ADDRESS !== undefined && env.RTC_LAN_ADDRESS !== '') rtc.lanAddress = advertisedAddress('RTC_LAN_ADDRESS', env.RTC_LAN_ADDRESS.trim());
  if (env.RTC_ADVERTISE !== undefined && env.RTC_ADVERTISE !== '') {
    rtc.advertise = env.RTC_ADVERTISE.split(',').map((ip) => advertisedAddress('RTC_ADVERTISE', ip.trim()));
  }
  return rtc;
}

function advertisedAddress(name: string, ip: string): string {
  if (!advertisable(ip)) throw new Error(`${name} "${ip}" is not an IPv4 address outside 172.16.0.0/12 and 100.64.0.0/10`);
  return ip;
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
  return httpUrl('PUBLIC_BASE', value);
}

function parseRendezvous(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : httpUrl('RENDEZVOUS_URL', value);
}

function httpUrl(name: string, value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error(`${name} "${value}" is not an http(s) URL`);
  return value;
}

function parseProxy(value: string | undefined): string {
  if (value === undefined) return 'caddy';
  if (!/^[A-Za-z0-9.:_-]+$/.test(value)) throw new Error(`TRUSTED_PROXY "${value}" is not an IP or hostname`);
  return value;
}

function parseTitleLibrary(value: string | undefined): 'owners' | 'everyone' {
  if (value === undefined || value === '') return 'owners';
  if (value !== 'owners' && value !== 'everyone') throw new Error(`TITLE_LIBRARY "${value}" is not owners or everyone`);
  return value;
}
