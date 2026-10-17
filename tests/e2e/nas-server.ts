/// <reference types="node" />
/**
 * The NAS side of nas.spec.ts, started by Playwright's webServer (`npx tsx tests/e2e/nas-server.ts`, after
 * `npm run server:build`): the built NAS server on NAS_PORT, serving a temporary copy of fixtures/synthetic as root
 * `syn`, and the rendezvous Worker's fetch handler, with in-memory storage, on RENDEZVOUS_PORT.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
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
/** A disc each browser deletes from the root between listing and opening it (`changed/<project>`). */
export const CHANGED_FOLDER = 'changed';
export const PROJECTS = ['chromium', 'firefox', 'webkit'] as const;
export const SERVER = join(REPO, 'server/dist/server.mjs');

/** The server's environment, also what `server.mjs owner-code` needs to mint a code for it. */
export const NAS_ENV: Readonly<Record<string, string>> = {
  LIBRARY_ROOTS: `syn=${NAS_ROOT}`,
  DATA_DIR: join(NAS_E2E_DIR, 'data'),
  PORT: String(NAS_PORT),
  PUBLIC_BASE: `http://localhost:${NAS_PORT}/api/`,
  RENDEZVOUS_URL,
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

async function main(): Promise<void> {
  rmSync(NAS_E2E_DIR, { recursive: true, force: true });
  mkdirSync(NAS_E2E_DIR, { recursive: true });
  cpSync(join(REPO, 'fixtures/synthetic'), NAS_ROOT, { recursive: true, preserveTimestamps: true });
  for (const project of PROJECTS) restoreChangedDisc(project);
  await startRendezvous();
  const server = spawn(process.execPath, [SERVER], { env: { ...process.env, ...NAS_ENV }, stdio: 'inherit' });
  server.on('exit', (code) => process.exit(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
