/// <reference types="node" />
/*
 * Development disc server (spec 2026-10-17 §4.5): serves disc folders on the Mac to devices on the home network with
 * HTTP byte ranges, and the built player from the same origin. The seed of the NAS server (cross-browser spec §4).
 *
 *   npm run disc-server -- --root <dir> [--root <dir>…] [--port 8443] [--cert cert.pem --key key.pem] [--dist dist]
 *
 * Node built-ins only. See README.md.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Disc {
  /** Stable across runs: a hash of the disc folder's real path. */
  readonly id: string;
  readonly name: string;
  /** Real path of the folder that contains BDMV. */
  readonly dir: string;
}

export interface DiscHandlerOptions {
  readonly roots: readonly string[];
  readonly token: string;
  /** The built player (`npm run build`), served without a token at `/`. */
  readonly distDir?: string;
  /** Test seam: the client address the LAN filter checks (the socket's by default). */
  readonly remoteAddressOf?: (req: IncomingMessage) => string | undefined;
}

/** How deep under a root disc folders are looked for. */
const MAX_DEPTH = 4;

/** The headers `public/_headers` sets, plus CORP: the player needs cross-origin isolation for SharedArrayBuffer. */
const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.jar': 'application/java-archive',
  '.txt': 'text/plain; charset=utf-8',
};

/** Loopback, RFC 1918, link-local and IPv6 unique-local addresses: the home network. Tailscale's 100.64/10 is not. */
export function isLocalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const a = mapped ? mapped[1]! : address;
  const kind = isIP(a);
  if (kind === 4) {
    const [b0, b1] = a.split('.').map(Number) as [number, number];
    return b0 === 127 || b0 === 10 || (b0 === 172 && b1 >= 16 && b1 <= 31) || (b0 === 192 && b1 === 168) || (b0 === 169 && b1 === 254);
  }
  if (kind === 6) {
    const lower = a.toLowerCase();
    if (lower === '::1') return true;
    const first = Number.parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00; // fe80::/10, fc00::/7
  }
  return false;
}

/**
 * One `bytes=` range against a file of `size` bytes: the inclusive span, 'unsatisfiable' (416), or null when the
 * header is malformed or asks for several ranges, which RFC 9110 lets a server ignore (the whole file is sent).
 */
export function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? Number.POSITIVE_INFINITY : Number(m[2]);
  if (end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

function childNamed(dir: string, name: string): string | null {
  try {
    const found = readdirSync(dir).find((n) => n.toUpperCase() === name);
    return found === undefined ? null : join(dir, found);
  } catch {
    return null;
  }
}

function isDisc(dir: string): boolean {
  const bdmv = childNamed(dir, 'BDMV');
  const index = bdmv && childNamed(bdmv, 'INDEX.BDMV');
  return index !== null && statSync(index).isFile();
}

/** Every folder under `roots` (or a root itself) that contains BDMV/index.bdmv, sorted by name. */
export function findDiscs(roots: readonly string[]): Disc[] {
  const discs = new Map<string, Disc>();
  const visit = (dir: string, depth: number): void => {
    if (isDisc(dir)) {
      const real = realpathSync(dir);
      const id = createHash('sha256').update(real).digest('hex').slice(0, 16);
      discs.set(id, { id, name: basename(dir), dir: real });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const child = join(dir, name);
      try {
        if (statSync(child).isDirectory()) visit(child, depth + 1);
      } catch {
        // unreadable or a dangling link
      }
    }
  };
  for (const root of roots) visit(resolve(root), 0);
  return [...discs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Every regular file of a disc as a root-relative path (the shape normalizeDiscPaths takes); links leaving the disc are skipped. */
function manifest(disc: Disc): Array<{ path: string; size: number }> {
  const files: Array<{ path: string; size: number }> = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(disc.dir, rel)).sort()) {
      if (name.startsWith('.')) continue;
      const path = rel === '' ? name : `${rel}/${name}`;
      const stat = containedStat(disc.dir, path);
      if (!stat) continue;
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path, size: stat.size });
    }
  };
  walk('');
  return files;
}

/** stat of `rel` under `dir`, or null when it does not exist or resolves (through a link) outside `dir`. */
function containedStat(dir: string, rel: string): Stats | null {
  try {
    const real = realpathSync(join(dir, rel));
    if (real !== dir && !real.startsWith(dir + sep)) return null;
    return statSync(real);
  } catch {
    return null;
  }
}

/**
 * The decoded segments of a URL path, or null when one is empty, `.` or `..`, or carries a slash, backslash or NUL
 * once decoded: nothing may name a file outside the folder it is served from.
 */
export function safeSegments(pathname: string): string[] | null {
  if (!pathname.startsWith('/')) return null;
  const raw = pathname.slice(1).split('/');
  if (raw.length === 1 && raw[0] === '') return [];
  const out: string[] = [];
  for (const segment of raw) {
    let s: string;
    try {
      s = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (s === '' || s === '.' || s === '..' || /[/\\\0]/.test(s)) return null;
    out.push(s);
  }
  return out;
}

function tokenMatches(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  const bearer = header && /^Bearer\s+(.+)$/i.exec(header);
  return bearer ? bearer[1]!.trim() : url.searchParams.get('token');
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${text}\n`);
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** A file, whole (200) or one range of it (206), streamed from disk: never more than the asked range is read. */
function sendFile(req: IncomingMessage, res: ServerResponse, path: string, size: number, headers: Record<string, string>): void {
  const range = req.headers.range === undefined ? null : parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy()); // the client gave up (a seek aborted the read): stop reading the disk
  stream.pipe(res);
}

/** The request handler: LAN filter, then the player at `/`, then the token-protected disc API under `/discs`. */
export function createDiscHandler(options: DiscHandlerOptions): RequestListener {
  const remoteOf = options.remoteAddressOf ?? ((req: IncomingMessage) => req.socket.remoteAddress);
  const distDir = options.distDir && existsSync(options.distDir) ? realpathSync(options.distDir) : null;
  let discs = findDiscs(options.roots);
  const discById = (id: string): Disc | undefined => {
    const found = discs.find((d) => d.id === id);
    if (found) return found;
    discs = findDiscs(options.roots); // a disc added since the last listing
    return discs.find((d) => d.id === id);
  };

  return (req, res) => {
    const remote = remoteOf(req);
    if (!remote || !isLocalAddress(remote)) return plain(res, 403, 'Only devices on the local network may connect.');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return plain(res, 405, 'Method not allowed.');
    const target = req.url ?? '/';
    const url = new URL(target, 'http://disc-server'); // for the query only: URL resolves `..` in the path
    const segments = safeSegments(target.split(/[?#]/, 1)[0]!);
    if (!segments) return plain(res, 400, 'Bad path.');

    if (segments[0] !== 'discs') {
      if (req.method === 'OPTIONS') return plain(res, 405, 'Method not allowed.');
      return serveApp(req, res, distDir, segments);
    }

    // CORS, so a player served elsewhere on the LAN (the Vite dev server) can open discs too; the token still gates every read
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' }
      : {};
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Authorization, Range', 'Access-Control-Max-Age': '600' });
      res.end();
      return;
    }
    if (!tokenMatches(requestToken(req, url), options.token)) return plain(res, 401, 'Missing or wrong token.');

    if (segments.length === 1) {
      discs = findDiscs(options.roots);
      return json(res, discs.map(({ id, name }) => ({ id, name })));
    }
    const disc = discById(segments[1]!);
    if (!disc) return plain(res, 404, 'No such disc.');
    if (segments.length === 3 && segments[2] === 'manifest') return json(res, { files: manifest(disc) });
    if (segments.length > 3 && segments[2] === 'file') {
      const rel = segments.slice(3).join('/');
      const stat = containedStat(disc.dir, rel);
      if (!stat?.isFile()) return plain(res, 404, 'No such file.');
      return sendFile(req, res, join(disc.dir, rel), stat.size, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    }
    return plain(res, 404, 'Not found.');
  };
}

function serveApp(req: IncomingMessage, res: ServerResponse, distDir: string | null, segments: readonly string[]): void {
  if (!distDir) return plain(res, 404, 'The player is not built: run npm run build, or pass --dist.');
  const rel = segments.length === 0 ? 'index.html' : segments.join('/');
  const stat = containedStat(distDir, rel);
  if (!stat?.isFile()) return plain(res, 404, 'Not found.');
  // no-cache: a rebuild shows up on reload (the service worker precaches by revision anyway)
  sendFile(req, res, join(distDir, rel), stat.size, {
    ...ISOLATION_HEADERS,
    'Content-Type': MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
}

/** The machine's loopback and private LAN IPv4 addresses: the only ones the server listens on. */
export function listenAddresses(): string[] {
  const out = new Set<string>(['127.0.0.1']);
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && isLocalAddress(info.address)) out.add(info.address);
    }
  }
  return [...out];
}

interface CliOptions {
  roots: string[];
  port: number;
  cert: string | null;
  key: string | null;
  dist: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { roots: [], port: 8443, cert: null, key: null, dist: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--root') opts.roots.push(value);
    else if (flag === '--port') opts.port = Number(value);
    else if (flag === '--cert') opts.cert = value;
    else if (flag === '--key') opts.key = value;
    else if (flag === '--dist') opts.dist = value;
    else throw new Error(`unknown option ${flag}`);
    i++;
  }
  if (opts.roots.length === 0) throw new Error('give at least one --root <dir>');
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) throw new Error('--port must be a port number');
  if ((opts.cert === null) !== (opts.key === null)) throw new Error('--cert and --key go together');
  return opts;
}

function main(argv: readonly string[]): void {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`disc-server: ${(e as Error).message}`);
    console.error('usage: npm run disc-server -- --root <dir> [--root <dir>…] [--port 8443] [--cert cert.pem --key key.pem] [--dist dist]');
    process.exit(2);
  }
  const token = randomBytes(18).toString('base64url');
  const handler = createDiscHandler({ roots: opts.roots, token, distDir: opts.dist });
  const tls = opts.cert && opts.key ? { cert: readFileSync(opts.cert), key: readFileSync(opts.key) } : null;
  // Without a certificate only loopback is served: a LAN page over plain HTTP is not a secure context (no SharedArrayBuffer).
  const addresses = tls ? listenAddresses() : ['127.0.0.1'];
  const scheme = tls ? 'https' : 'http';
  for (const address of addresses) {
    const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
    server.on('error', (e) => console.error(`disc-server: ${address}:${opts.port}: ${e.message}`));
    server.listen(opts.port, address);
  }
  const discs = findDiscs(opts.roots);
  if (!existsSync(opts.dist)) console.warn(`disc-server: ${opts.dist} does not exist; run npm run build to serve the player.`);
  console.log(tls ? `certificate: ${resolve(opts.cert!)}` : 'no --cert/--key: plain HTTP on loopback only (see tools/disc-server/README.md).');
  // the address devices reach: a private one before a link-local (169.254) one
  const lan = addresses.find((a) => a !== '127.0.0.1' && !a.startsWith('169.254.')) ?? addresses.find((a) => a !== '127.0.0.1') ?? '127.0.0.1';
  const origin = `${scheme}://${lan}:${opts.port}`;
  console.log(`\nPlayer (lists the discs): ${origin}/?token=${token}`);
  console.log(discs.length === 0 ? '\nNo discs (folders containing BDMV/index.bdmv) under the roots.' : '\nDiscs:');
  for (const d of discs) console.log(`  ${d.name}: ${origin}/?disc=${encodeURIComponent(`${origin}/discs/${d.id}`)}&token=${token}`);
  console.log(`\nListening on ${addresses.map((a) => `${a}:${opts.port}`).join(', ')}. Ctrl-C stops.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
