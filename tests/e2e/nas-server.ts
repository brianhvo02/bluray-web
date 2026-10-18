/// <reference types="node" />
/**
 * The NAS side of nas.spec.ts, started by Playwright's webServer (`npx tsx tests/e2e/nas-server.ts`, after
 * `npm run server:build`): the built NAS server on NAS_PORT, serving a temporary copy of fixtures/synthetic as root
 * `syn`, and the rendezvous Worker's fetch handler, with in-memory storage, on RENDEZVOUS_PORT.
 *
 * The title library's AniList and TMDB are the recorded entries of tests/e2e/fixtures/nas-metadata.json
 * (`METADATA_FIXTURE`, ruling R3), made-up titles that match the folders TITLE_DISCS puts synthetic discs in. Starfall
 * Wanderer's runtime of 0.0667 minutes (4 s) makes disc1's 4-second playlist 00001 its one episode.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Not 4190: that is ManageSieve's, one of the Fetch standard's bad ports, which Firefox and WebKit refuse to reach. */
export const NAS_PORT = 4192;
export const RENDEZVOUS_PORT = 4191;
export const RENDEZVOUS_URL = `http://localhost:${RENDEZVOUS_PORT}`;
/** Recreated on every start. */
export const NAS_E2E_DIR = join(REPO, '.cache/e2e-nas');
/** The copy of fixtures/synthetic the server serves as root `syn`. */
export const NAS_ROOT = join(NAS_E2E_DIR, 'syn');
/** Discs each browser deletes from the root: between listing and pre-flight (`changed/<project>`), and between pre-flight and opening (`changed/<project>-open`). */
export const CHANGED_FOLDER = 'changed';
export const PROJECTS = ['chromium', 'firefox', 'webkit'] as const;
export const SERVER = join(REPO, 'server/dist/server.mjs');
/** The recorded metadata entries the server matches discs against. */
export const METADATA_FIXTURE = join(REPO, 'tests/e2e/fixtures/nas-metadata.json');
/** Copies of synthetic discs in the folders the metadata fixture's titles match: root-relative folder → fixture disc. */
export const TITLE_DISCS: Readonly<Record<string, string>> = {
  'Anime/Starfall Wanderer (星降りの旅人)/Starfall Wanderer Vol.1': 'disc1',
  'Anime/Starfall Wanderer (星降りの旅人)/Starfall Wanderer Vol.2': 'disc-subs',
  'Anime/Moonlit Harbor (月影の港)/Moonlit Harbor': 'disc2',
  'Music/Lantern Parade Live 2024': 'disc3',
};

/**
 * Each browser's own Unsorted discs (the owner screens' tests change their choices, and the projects run side by side):
 * two discs of a made-up series with no disc number (`no-disc-number`, the series suggested, each with a catalogue
 * number), and one disc nothing names (`no-title`). Named in the metadata fixture as anilist:90011x.
 */
export const OWNER_SERIES: Readonly<Record<(typeof PROJECTS)[number], string>> = { chromium: 'Ember Tide', firefox: 'Paper Comet', webkit: 'Glass Orchard' };
/** The project's disc nothing names, its folder name unique so each browser finds only its own card. */
export const ownerStray = (project: (typeof PROJECTS)[number]): string => `Stray Reel ${project}`;
/** Root-relative folders of a project's owner discs: the series' two, then the stray one. */
export function ownerDiscs(project: (typeof PROJECTS)[number]): { series: [string, string]; stray: string } {
  const name = OWNER_SERIES[project];
  const at = `Owner/${project}`;
  return { series: [`${at}/${name}/${name} [ZMXA-1101]`, `${at}/${name}/${name} [ZMXA-1102]`], stray: `${at}/${ownerStray(project)}` };
}

/** The server's environment, also what `server.mjs owner-code` needs to mint a code for it. */
export const NAS_ENV: Readonly<Record<string, string>> = {
  LIBRARY_ROOTS: `syn=${NAS_ROOT}`,
  DATA_DIR: join(NAS_E2E_DIR, 'data'),
  PORT: String(NAS_PORT),
  PUBLIC_BASE: `http://localhost:${NAS_PORT}/api/`,
  RENDEZVOUS_URL,
  // Nothing proxies here; the default ('caddy') would only log that it does not resolve.
  TRUSTED_PROXY: '127.0.0.1',
  METADATA_FIXTURE,
};

/** Puts `changed/<project>` (a copy of disc1, timestamps kept so its disc id never changes) back in the root. */
export function restoreChangedDisc(project: string): string {
  const dir = join(NAS_ROOT, CHANGED_FOLDER, project);
  cpSync(join(REPO, 'fixtures/synthetic/disc1'), dir, { recursive: true, preserveTimestamps: true });
  return dir;
}

/** The rendezvous Worker's fetch handler over node:http, as its tests run it (no workerd). */
async function startRendezvous(): Promise<void> {
  // Imported here: playwright.config.ts and nas.spec.ts import this file's constants only.
  const { CodeRegistry } = await import('../../rendezvous/src/code-registry');
  const { default: worker } = await import('../../rendezvous/src/index');
  const { memoryState } = await import('../../rendezvous/src/memory-state');
  const registry = new CodeRegistry(memoryState());
  const env = { CODE_REGISTRY: { idFromName: (name: string) => ({ name }), get: () => ({ fetch: (r: Request) => registry.fetch(r) }) } };
  let client = 0;
  createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      // Every request counts as a new client: a run pairs a browser for each test, far more than the 10 lookups a
      // minute one address gets (that limit is unit-tested in rendezvous/).
      client = (client + 1) % 65_536;
      headers.set('CF-Connecting-IP', `198.18.${client >> 8}.${client & 255}`);
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const request = new Request(`${RENDEZVOUS_URL}${req.url ?? '/'}`, { method: req.method, headers, body });
      worker.fetch(request, env).then(
        async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        },
        (err: unknown) => {
          console.error('rendezvous stand-in failed', err);
          res.writeHead(500).end();
        },
      );
    });
  }).listen(RENDEZVOUS_PORT);
}

/** Sets every file and folder under `dir` to `when`, deepest first. */
function backdateTree(dir: string, when: Date): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) backdateTree(join(dir, e.name), when);
    else utimesSync(join(dir, e.name), when, when);
  }
  utimesSync(dir, when, when);
}

async function main(): Promise<void> {
  // A fresh checkout (CI) gives the fixtures modification times of minutes ago, and the scan leaves out discs written in
  // the last hour (a download still in progress). The copies below keep these times, so set them in the past first.
  backdateTree(join(REPO, 'fixtures/synthetic'), new Date('2024-01-01T00:00:00Z'));
  rmSync(NAS_E2E_DIR, { recursive: true, force: true });
  mkdirSync(NAS_E2E_DIR, { recursive: true });
  cpSync(join(REPO, 'fixtures/synthetic'), NAS_ROOT, { recursive: true, preserveTimestamps: true });
  for (const project of PROJECTS) for (const name of [project, `${project}-open`]) restoreChangedDisc(name);
  for (const [folder, disc] of Object.entries(TITLE_DISCS)) cpSync(join(REPO, 'fixtures/synthetic', disc), join(NAS_ROOT, folder), { recursive: true, preserveTimestamps: true });
  // Minimal discs: index.bdmv and one clip whose size is unique, so no two share a content fingerprint (copies would
  // share owner choices). Their times are set in the past: the scan leaves out discs written moments ago (a download
  // still in progress).
  const past = new Date('2024-01-01T00:00:00Z');
  let size = 0;
  for (const project of PROJECTS) {
    const { series, stray } = ownerDiscs(project);
    for (const folder of [...series, stray]) {
      const bdmv = join(NAS_ROOT, folder, 'BDMV');
      mkdirSync(join(bdmv, 'STREAM'), { recursive: true });
      cpSync(join(REPO, 'fixtures/synthetic/disc1/BDMV/index.bdmv'), join(bdmv, 'index.bdmv'));
      writeFileSync(join(bdmv, 'STREAM/00001.m2ts'), Buffer.alloc(192 * (1000 + size++)));
      for (const path of ['STREAM/00001.m2ts', 'index.bdmv', 'STREAM', '']) utimesSync(join(bdmv, path), past, past);
    }
  }
  await startRendezvous();
  const server = spawn(process.execPath, [SERVER], { env: { ...process.env, ...NAS_ENV }, stdio: 'inherit' });
  server.on('exit', (code) => process.exit(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
