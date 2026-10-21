/**
 * The 5e live device check (Task 9): two made-up test people on the live NAS, their devices paired on a preview origin
 * of the player, BD-J saved data checked across people and devices, and the library discs left unconfirmed by the
 * library check (tools/bdj-library) opened from the NAS on a touch device with screenshots after every step.
 *
 *   npx tsx tools/devices/live-check.ts --origin https://<branch>.bluray-web.pages.dev --out <dir outside the repo> \
 *     --mika-phone ios:<udid> --mika-tablet ios:<udid> [--sora-a chrome-profile] [--sora-b chrome] \
 *     [--store-disc auto|<library path>|none] [--rehearse-store <library path>] [--library] [--disc <id>]…
 *
 * What it does, in order (each part is skipped with a reason when it cannot run):
 *   1. People. "Mika (test)" is made (or found) by the NAS's owner tooling over ssh (server/deploy/deploy.sh
 *      --owner-code --person), and a headless controller device is paired for it (as scripts/verify-level.ts pairs).
 *      "Sora (test)" is made through the controller's owner session (POST admin/codes {newPerson}) and gets its own
 *      controller. Every browser device is paired with a fresh code (POST admin/codes {personId}) through the app's
 *      own pairing screen (`/?pair=<code>`), on --origin only. Before pairing, a browser already paired on that origin
 *      as anyone but a test person stops the run: it is never re-paired.
 *   2. Store (disc-bdj-store, fixtures/synthetic/disc-bdj-store, from the NAS library): Mika's phone opens it and shows
 *      count 0 (libbluray's plane hash for the first opening), and Mika's NAS store reaches 1 (read back by Mika's
 *      controller); Mika's tablet shows 1 and the NAS reaches 2; Sora's first browser shows 0 and Sora's NAS store
 *      reaches 1 while Mika's stays 2; Sora's second browser shows 1 (Sora's count, never Mika's 2).
 *      --rehearse-store <library path> runs the same steps on another disc without expecting counts (a dry run).
 *   3. Library (--library): on Mika's phone, each disc id (default: the 14 unconfirmed ones) is mapped through
 *      $BDJ_LIBRARY_DIR/map.tsv to its NAS library disc, opened from the NAS, and driven with tools/bdj-library/
 *      generic.keys through the on-screen remote, with a screenshot after every step (<out>/<id>/).
 *   4. Clean-up, always (also on Ctrl-C): each browser forgets its test pairing and test saved data before it closes;
 *      then Sora, then Mika is deleted (DELETE admin/people/<id>, which also clears their saved data on the NAS), and the
 *      NAS's people file is read back over ssh to confirm no test person, device or saved data is left.
 *
 * Targets: ios:<udid> (safaridriver on a real device: touch), sim:<name> (Appium on an iOS Simulator: touch),
 * chrome-profile (installed Chrome with a fresh temporary profile), chrome (another Chrome with its own context).
 * Device ids come only from the command line, and results name devices by role. Tokens and pairing codes are never
 * printed or written. Results go to --out, which must lie outside the repository.
 */

import { execFile, spawn } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MenuKey } from '../../src/engine/protocol';
import { readTar } from '../../src/engine/bdj/store/tar';
import type { DiscEntry, LibraryListing } from '../../src/engine/disc/nas-api';
import { parseKeyScript, type KeyStep } from '../../tests/bdj/key-script';
import { BAND_POINT, environment, openRemote, Page, remoteOpsFor, startTargetDriver, type GateDriver, type RemoteOps } from './gate';
import { PageReloadedError, write } from './session';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const MIKA = 'Mika (test)';
export const SORA = 'Sora (test)';
const TEST_NAMES: readonly string[] = [MIKA, SORA];
const CONTROLLER_NAME = 'live-check controller';
/** The production player: its storage is never touched. */
export const PRODUCTION_ORIGIN = 'https://bluray-web.pages.dev';
/** The library check's unconfirmed discs (ledger, Task 7 and 7b). */
export const UNCONFIRMED = [
  '085018d8d8', '14ac0689d3', '1f2a950e80', '52c889f003', '5a26f0e0a5', '5b2a44a1ad', '67e6e09cab',
  '735a50dd72', '8ea8027fb4', 'a9b45f88a5', 'c8ebb51ad0', 'd1ec3e501e', 'ed40609362', '49deae306e',
] as const;
/** disc-bdj-store's organisation and the app's count file (scripts/make-bdj-store-disc.ts). */
const STORE_ORG = '7fff0002';
const STORE_COUNT = '4001/count';
const STORE_DISC_NAME = 'disc-bdj-store';
const FOLDER_KEY = 'bluray-web:nas-folder';

// ---------------------------------------------------------------------------------------------------------------------
// Pure parts (live-check.test.ts)

/** The settled plane libbluray drew at disc-bdj-store's n-th opening on one storage (index 0: "count 0"). */
export function storeHashes(read: (n: number) => string = (n) => readFileSync(join(REPO, `tests/bdj/golden/disc-bdj-store.open.${n}.jsonl`), 'utf8')): string[] {
  return [1, 2, 3].map((n) => {
    const end = read(n).trim().split('\n').map((l) => JSON.parse(l) as { script?: string; hash?: string }).find((e) => e.script === 'end');
    if (!end?.hash) throw new Error(`disc-bdj-store.open.${n}.jsonl has no end hash`);
    return end.hash;
  });
}

/** The count a plane hash shows (its index in storeHashes), or null for another plane. */
export function countOf(hash: string | null, hashes: readonly string[]): number | null {
  const i = hash === null ? -1 : hashes.indexOf(hash);
  return i < 0 ? null : i;
}

/** Refuses the production origin and anything that is not a Pages preview or a local preview. */
export function checkOrigin(origin: string): string {
  const u = new URL(origin);
  if (u.origin !== origin.replace(/\/+$/, '')) throw new Error(`--origin ${origin}: give an origin only (no path)`);
  if (u.origin === PRODUCTION_ORIGIN) throw new Error('--origin is the live site: the check runs on a preview origin only');
  if (!/^https:\/\/[a-z0-9-]+\.bluray-web\.pages\.dev$/.test(u.origin) && !/^http:\/\/localhost:4173$/.test(u.origin)) {
    throw new Error(`--origin ${u.origin}: not a preview of the player (https://<branch>.bluray-web.pages.dev)`);
  }
  return u.origin;
}

/** The code `node server.mjs owner-code` printed. */
export function parseOwnerCode(out: string): { code: string; person: string | null; rendezvous: boolean } {
  const code = /Owner pairing code: ([0-9A-Z-]+)/.exec(out)?.[1];
  if (!code) throw new Error('the owner tooling printed no pairing code');
  return { code, person: /^Person: (.*)$/m.exec(out)?.[1] ?? null, rendezvous: /Rendezvous: registered/.test(out) };
}

export interface LibraryRoot {
  readonly name: string;
  /** The folder on the NAS host (/mnt/…), as the library check's map.tsv names paths. */
  readonly hostDir: string;
}

/**
 * The library roots from server/deploy/compose.yaml's LIBRARY_ROOTS (`name=dir` or `name=dir@group`), with the bind
 * mounts' container targets mapped back to their host sources.
 */
export function parseRoots(compose: string): LibraryRoot[] {
  const line = /LIBRARY_ROOTS:\s*(\S+)/.exec(compose)?.[1];
  if (!line) throw new Error('compose.yaml has no LIBRARY_ROOTS');
  const binds = new Map<string, string>();
  for (const m of compose.matchAll(/source:\s*(\S+)\s*\n\s*target:\s*(\S+)/g)) binds.set(m[2]!, m[1]!);
  return line.split(',').map((entry) => {
    const eq = entry.indexOf('=');
    const name = entry.slice(0, eq);
    let dir = entry.slice(eq + 1);
    const at = dir.lastIndexOf('@');
    if (at > 0) dir = dir.slice(0, at);
    const mount = [...binds.keys()].filter((t) => dir === t || dir.startsWith(`${t}/`)).sort((a, b) => b.length - a.length)[0];
    return { name, hostDir: mount ? binds.get(mount)! + dir.slice(mount.length) : dir };
  });
}

/** A host path (map.tsv) as the NAS library's root-relative path, or null when no root holds it. */
export function libraryPath(hostPath: string, roots: readonly LibraryRoot[]): string | null {
  const root = [...roots].sort((a, b) => b.hostDir.length - a.hostDir.length).find((r) => hostPath.startsWith(`${r.hostDir}/`));
  return root ? `${root.name}/${hostPath.slice(root.hostDir.length + 1)}` : null;
}

/** map.tsv: library-check id → host path. */
/** The folder a run places its test disc in: `<root>/zz-live-check-<run id>` (run id: 8 lowercase hex digits). */
export function testDiscFolder(root: LibraryRoot, runId: string): { hostDir: string; libraryPath: string } {
  if (!/^[0-9a-f]{8}$/.test(runId)) throw new Error(`bad run id ${runId}`);
  if (!/^\/mnt\/drv\d+\/[A-Za-z]+$/.test(root.hostDir)) throw new Error(`root ${root.name} is not a /mnt/drv<n>/<folder> root`);
  return { hostDir: `${root.hostDir}/zz-live-check-${runId}`, libraryPath: `${root.name}/zz-live-check-${runId}/${STORE_DISC_NAME}` };
}

/**
 * Whether `dir` is exactly the folder this run placed (the only path the clean-up may delete): one of the roots, then
 * `zz-live-check-<this run's id>`, nothing above or below it, no quotes or other characters a shell would read.
 */
export function ownTestFolder(dir: string, runId: string, roots: readonly LibraryRoot[]): boolean {
  if (!/^[0-9a-f]{8}$/.test(runId)) return false;
  return roots.some((r) => /^\/mnt\/drv\d+\/[A-Za-z]+$/.test(r.hostDir) && dir === `${r.hostDir}/zz-live-check-${runId}`);
}

export function parseMap(tsv: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of tsv.split('\n').slice(1)) {
    const [id, , , path] = line.split('\t');
    if (id && path) out.set(id, path);
  }
  return out;
}

const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export interface Options {
  origin: string;
  nas: string;
  out: string;
  mikaPhone: string | null;
  mikaTablet: string | null;
  soraA: string | null;
  soraB: string | null;
  /** 'auto' (look for disc-bdj-store in the library), a library path, or null (no store check). */
  /** 'place' (copy disc-bdj-store into a folder of its own under --place-root, removed at the end), 'auto', a library path, or null. */
  storeDisc: string | null;
  /** The library root (LIBRARY_ROOTS name) the test disc is placed under. */
  placeRoot: string;
  rehearseStore: string | null;
  library: boolean;
  discs: string[];
  libraryDir: string;
  wdPorts: [number, number];
  headless: boolean;
  callTimeoutMs: number;
}

const USAGE =
  'usage: live-check.ts --origin <preview origin> --out <dir> --nas <api base> (or $LIVE_CHECK_NAS) [--mika-phone <target>] [--mika-tablet <target>] [--sora-a chrome-profile] [--sora-b chrome] ' +
  '[--store-disc place|auto|<library path>|none] [--place-root drv8] [--rehearse-store <library path>|<id>] [--library] [--disc <id>]… [--library-dir dir] [--wd-ports 4211,4212] [--headless] [--call-timeout ms]';

export function parseLiveArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Options {
  const o: Options = {
    origin: '', nas: env.LIVE_CHECK_NAS ?? '', out: '', mikaPhone: null, mikaTablet: null, soraA: 'chrome-profile', soraB: 'chrome', storeDisc: 'place', placeRoot: 'drv8', rehearseStore: null,
    library: false, discs: [], libraryDir: env.BDJ_LIBRARY_DIR ?? join(homedir(), '.cache/bluray-web/bdj-library'), wdPorts: [4211, 4212], headless: false, callTimeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--library') { o.library = true; continue; }
    if (flag === '--headless') { o.headless = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
    switch (flag) {
      case '--origin': o.origin = v; break;
      case '--nas': o.nas = v; break;
      case '--out': o.out = v; break;
      case '--mika-phone': o.mikaPhone = v; break;
      case '--mika-tablet': o.mikaTablet = v; break;
      case '--sora-a': o.soraA = v === 'none' ? null : v; break;
      case '--sora-b': o.soraB = v === 'none' ? null : v; break;
      case '--store-disc': o.storeDisc = v === 'none' ? null : v; break;
      case '--place-root': o.placeRoot = v; break;
      case '--rehearse-store': o.rehearseStore = v; break;
      case '--disc': o.discs.push(v); break;
      case '--library-dir': o.libraryDir = v; break;
      case '--wd-ports': {
        const ports = v.split(',').map(Number);
        if (ports.length !== 2 || ports.some((p) => !Number.isInteger(p) || p <= 4200 || p > 65535 || p === 4191 || p === 4192)) throw new Error('--wd-ports: two ports above 4200 (never 4191/4192)');
        o.wdPorts = [ports[0]!, ports[1]!];
        break;
      }
      case '--call-timeout': o.callTimeoutMs = Number(v); break;
      default: throw new Error(`unknown option ${flag}\n${USAGE}`);
    }
  }
  if (!o.origin || !o.out) throw new Error(USAGE);
  // no default: the NAS is the caller's to name
  if (!o.nas) throw new Error(`no NAS given: pass --nas <api base> or set LIVE_CHECK_NAS (for example https://<nas host>/bluray/api/)\n${USAGE}`);
  if (!o.nas.endsWith('/')) o.nas = `${o.nas}/`;
  o.origin = checkOrigin(o.origin);
  const out = resolve(o.out);
  const rel = relative(REPO, out);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) throw new Error('--out must lie outside the repository (screenshots show real discs)');
  o.out = out;
  if (o.discs.length === 0) o.discs = [...UNCONFIRMED];
  for (const t of [o.mikaPhone, o.mikaTablet, o.soraA, o.soraB]) {
    if (t !== null && !/^(ios:[0-9A-Fa-f-]{20,}|sim:.+|chrome-profile|chrome)$/.test(t)) throw new Error(`unknown target ${t}\n${USAGE}`);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------------
// The NAS: a headless controller device per test person (pairing as scripts/verify-level.ts does)

class HttpError extends Error {
  constructor(readonly status: number, body: string, what: string) {
    super(`${what}: HTTP ${status} ${body.slice(0, 200)}`);
  }
}

const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

class Controller {
  private session: { token: string; expiresAt: number } | null = null;
  private constructor(readonly base: string, readonly deviceId: string, readonly personId: string, private readonly key: webcrypto.CryptoKeyPair) {}

  static async pair(base: string, code: string): Promise<Controller> {
    const key = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', key.publicKey);
    const res = await fetch(`${base}pair/redeem`, jsonPost({ code: code.trim().toUpperCase(), deviceName: CONTROLLER_NAME, publicKeyJwk: { kty, crv, x, y } }));
    if (!res.ok) throw new HttpError(res.status, await res.text(), 'pairing the controller');
    const { deviceId, personId, owner } = (await res.json()) as { deviceId: string; personId: string; owner: boolean };
    if (!owner) throw new Error('the controller is not an owner device');
    return new Controller(base, deviceId, personId, key);
  }

  private async token(fresh: boolean): Promise<string> {
    if (!fresh && this.session && this.session.expiresAt - Date.now() > 5 * 60_000) return this.session.token;
    const c = await fetch(`${this.base}session/challenge`, jsonPost({ deviceId: this.deviceId }));
    if (!c.ok) throw new HttpError(c.status, await c.text(), 'session challenge');
    const { challenge } = (await c.json()) as { challenge: string };
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.key.privateKey, new TextEncoder().encode(challenge));
    const res = await fetch(`${this.base}session`, jsonPost({ deviceId: this.deviceId, challenge, signature: Buffer.from(sig).toString('base64url') }));
    if (!res.ok) throw new HttpError(res.status, await res.text(), 'session');
    this.session = (await res.json()) as { token: string; expiresAt: number };
    return this.session.token;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${await this.token(attempt > 0)}`);
      const res = await fetch(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
      if (res.status !== 401 || attempt > 0) return res;
      await res.body?.cancel();
    }
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) throw new HttpError(res.status, await res.text(), path.split('?')[0]!);
    return (await res.json()) as T;
  }

  /** disc-bdj-store's count in this person's NAS store, or null when there is none. */
  async storeCount(): Promise<string | null> {
    const res = await this.fetch(`bdj-store/persistent/${STORE_ORG}`);
    if (!res.ok) throw new HttpError(res.status, await res.text(), 'reading the NAS store');
    const f = readTar(new Uint8Array(await res.arrayBuffer())).find((e) => e.path === STORE_COUNT);
    return f ? new TextDecoder().decode(f.bytes) : null;
  }
}

interface PersonRow {
  id: string;
  name: string;
  owner: boolean;
}

/** One owner code from the NAS's owner tooling over ssh (deploy.sh --owner-code --person <name>). */
function sshOwnerCode(person: string): Promise<{ code: string; person: string | null; rendezvous: boolean }> {
  return new Promise((res, rej) =>
    execFile('bash', [join(REPO, 'server/deploy/deploy.sh'), '--owner-code', '--person', person], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) rej(new Error(`deploy.sh --owner-code: ${err.message} ${String(stderr).slice(0, 300)}`));
      else {
        try {
          res(parseOwnerCode(String(stdout)));
        } catch (e) {
          rej(e as Error);
        }
      }
    }),
  );
}

/** Runs a read-only command on the NAS host. */
function sshRead(script: string): Promise<string> {
  const host = process.env.BLURAY_NAS_HOST ?? 'mediaserver';
  return new Promise((res, rej) =>
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host, script], { timeout: 60_000 }, (err, stdout, stderr) => (err ? rej(new Error(`ssh: ${err.message} ${String(stderr).slice(0, 200)}`)) : res(String(stdout)))),
  );
}

class People {
  mika: Controller | null = null;
  sora: Controller | null = null;
  mikaId: string | null = null;
  soraId: string | null = null;
  /** People that were not test people when the run started: never touched; checked unchanged at the end. */
  others: PersonRow[] = [];
  deleted: string[] = [];
  private cleaned = false;

  constructor(private readonly base: string, private readonly log: (m: string) => void) {}

  async setUp(): Promise<void> {
    const first = await sshOwnerCode(MIKA);
    if (first.person !== MIKA) throw new Error(`the owner tooling paired "${first.person}", not ${MIKA}`);
    this.mika = await Controller.pair(this.base, first.code);
    this.mikaId = this.mika.personId;
    const people = await this.people();
    const mikaRow = people.find((p) => p.id === this.mikaId);
    if (mikaRow?.name !== MIKA) throw new Error(`the controller's person is "${mikaRow?.name}", not ${MIKA}`);
    this.others = people.filter((p) => !TEST_NAMES.includes(p.name));
    this.log(`${MIKA}: person ${this.mikaId}; ${this.others.length} other people on the NAS (left alone)`);
    const leftover = people.find((p) => p.name === SORA);
    const made = await this.mika.json<{ code: string; personId: string; personName: string }>(
      'admin/codes',
      jsonPost(leftover ? { personId: leftover.id } : { newPerson: { name: SORA, owner: true } }),
    );
    if (made.personName !== SORA) throw new Error(`the code is for "${made.personName}", not ${SORA}`);
    this.soraId = made.personId;
    this.sora = await Controller.pair(this.base, made.code);
    this.log(`${SORA}: person ${this.soraId}${leftover ? ' (left over from an earlier run)' : ''}`);
    // a test person left over from an earlier run may hold saved data: start both from nothing
    for (const id of [this.mikaId, this.soraId]) {
      const r = await this.mika.fetch(`admin/people/${encodeURIComponent(id)}/saved-data`, { method: 'DELETE' });
      if (r.status !== 204) throw new HttpError(r.status, await r.text(), 'clearing a test person\'s saved data');
    }
  }

  async people(): Promise<PersonRow[]> {
    return (await this.mika!.json<{ people: PersonRow[] }>('admin/people')).people;
  }

  /** A fresh single-use code for a browser device of `personId` (registered with the rendezvous, so the app can pair). */
  async code(personId: string): Promise<string> {
    const r = await this.mika!.json<{ code: string; rendezvous: boolean; personId: string; personName: string }>('admin/codes', jsonPost({ personId }));
    if (r.personId !== personId || !TEST_NAMES.includes(r.personName)) throw new Error('the code is not for a test person');
    if (!r.rendezvous) throw new Error('the NAS could not register the code with the rendezvous: the app cannot pair with it');
    return r.code;
  }

  /** Deletes Sora, then Mika (each only when its name is still a test name), then confirms over ssh. */
  async cleanUp(): Promise<{ confirmed: boolean; detail: string }> {
    if (this.cleaned) return { confirmed: true, detail: 'already cleaned' };
    this.cleaned = true;
    const problems: string[] = [];
    // Mika's controller may be missing (the run failed while pairing it): a fresh owner code gives another
    if (!this.mika && this.mikaId === null) {
      const people = await this.peopleOverSsh().catch(() => null);
      if (people?.some((p) => p.name === MIKA)) {
        const c = await sshOwnerCode(MIKA);
        this.mika = await Controller.pair(this.base, c.code);
        this.mikaId = this.mika.personId;
      }
    }
    if (this.mika) {
      const before = await this.people().catch(() => [] as PersonRow[]);
      if (!this.soraId) this.soraId = before.find((p) => p.name === SORA)?.id ?? null;
      for (const id of [this.soraId, this.mikaId]) {
        if (!id) continue;
        const row = before.find((p) => p.id === id);
        if (row && !TEST_NAMES.includes(row.name)) {
          problems.push(`person ${id} is "${row.name}", not a test person: left alone`);
          continue;
        }
        if (!row) continue;
        const r = await this.mika.fetch(`admin/people/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((e: unknown) => e as Error);
        if (r instanceof Error) problems.push(`deleting ${row.name}: ${r.message}`);
        else if (r.status !== 204) problems.push(`deleting ${row.name}: HTTP ${r.status} ${await r.text()}`);
        else {
          this.deleted.push(row.name);
          this.log(`deleted ${row.name} (${id}) and its devices and saved data`);
        }
        if (id === this.soraId && !(r instanceof Error) && r.status === 204) {
          const after = await this.people();
          if (after.some((p) => p.id === id || p.name === SORA)) problems.push(`${SORA} is still in the admin listing`);
          else this.log(`admin listing: ${SORA} gone; ${after.filter((p) => !TEST_NAMES.includes(p.name)).length} other people`);
        }
      }
    }
    // the controller of a deleted person can no longer list: the NAS's own people file, read over ssh, confirms it
    const left = await this.peopleOverSsh().catch((e: unknown) => {
      problems.push(`reading the NAS's people over ssh: ${(e as Error).message}`);
      return null;
    });
    if (left) {
      const test = left.filter((p) => TEST_NAMES.includes(p.name) || p.id === this.mikaId || p.id === this.soraId);
      if (test.length > 0) problems.push(`still on the NAS: ${test.map((p) => p.name).join(', ')}`);
      const devices = await sshRead(`docker exec bluray-server node -e 'const a=require("/data/auth.json");const ids=${JSON.stringify([this.mikaId, this.soraId].filter(Boolean))};console.log(a.devices.filter(d=>ids.includes(d.personId)).length)'`).catch(() => '?');
      if (devices.trim() !== '0') problems.push(`test devices left: ${devices.trim()}`);
      const ids = [this.mikaId, this.soraId].filter((x): x is string => x !== null);
      if (ids.length > 0) {
        const data = await sshRead(`docker exec bluray-server sh -c '${ids.map((id) => `test -e /data/users/${id} && echo ${id}`).join('; ')}; true'`).catch(() => '?');
        if (data.trim() !== '') problems.push(`saved data left: ${data.trim()}`);
      }
      const othersNow = left.filter((p) => !TEST_NAMES.includes(p.name));
      if (this.others.length > 0 && (othersNow.length !== this.others.length || this.others.some((o) => !othersNow.some((p) => p.id === o.id && p.name === o.name)))) {
        problems.push('the other people changed during the run (not by this check: it never writes to them)');
      }
      if (problems.length === 0) this.log(`NAS people file: no test person, device or saved data left; ${othersNow.length} other people as before`);
    }
    return { confirmed: problems.length === 0, detail: problems.join('; ') || 'no test person, device or saved data left' };
  }

  /** The NAS's people (id, name, owner), read from its auth file over ssh. */
  private async peopleOverSsh(): Promise<PersonRow[]> {
    const out = await sshRead(`docker exec bluray-server node -e 'const a=require("/data/auth.json");console.log(JSON.stringify(a.people.map(p=>({id:p.id,name:p.name,owner:p.owner}))))'`);
    return JSON.parse(out) as PersonRow[];
  }
}

interface MetadataStatus {
  running: boolean;
  filed: number;
  unsorted: number;
  music: number;
  lastRunAt: number | null;
}

/** Pipes a local tar of `fixtures/synthetic/disc-bdj-store` into `script` run over ssh on the NAS host. */
function sshUntar(script: string): Promise<void> {
  const host = process.env.BLURAY_NAS_HOST ?? 'mediaserver';
  return new Promise((res, rej) => {
    // no AppleDouble files or macOS extended attributes: the NAS gets the fixture's files and nothing else
    const tar = spawn('tar', ['--no-mac-metadata', '--no-xattrs', '-C', join(REPO, 'fixtures/synthetic'), '-cf', '-', STORE_DISC_NAME], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host, script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    tar.stderr.on('data', (d: Buffer) => (err += d.toString()));
    ssh.stderr.on('data', (d: Buffer) => (err += d.toString()));
    tar.stdout.pipe(ssh.stdin);
    const timer = setTimeout(() => ssh.kill('SIGKILL'), 120_000);
    ssh.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) res();
      else rej(new Error(`copying the test disc: ssh exit ${code}: ${err.slice(0, 300)}`));
    });
  });
}

/**
 * disc-bdj-store placed on the NAS for one run, in a folder of its own (`<root>/zz-live-check-<run id>/`), and removed
 * at the end; the library is rescanned both times through the owner route (POST admin/rescan).
 */
class TestDisc {
  readonly runId = randomBytes(4).toString('hex');
  readonly hostDir: string;
  readonly libraryPath: string;
  private readonly roots: LibraryRoot[];
  /** Set once the folder exists on the NAS (made by this run): only then may the clean-up remove it. */
  created = false;
  removed = false;
  /** The title matcher's counts before the disc was placed. */
  statusBefore: MetadataStatus | null = null;
  readonly report: { placed?: boolean; listedAfterMs?: number; removed?: boolean; gone?: boolean; unlisted?: boolean; countsRestored?: boolean; detail: string[] } = { detail: [] };

  constructor(rootName: string, private readonly log: (m: string) => void) {
    this.roots = parseRoots(readFileSync(join(REPO, 'server/deploy/compose.yaml'), 'utf8'));
    const root = this.roots.find((r) => r.name === rootName);
    if (!root) throw new Error(`--place-root ${rootName}: not a library root (${this.roots.map((r) => r.name).join(', ')})`);
    ({ hostDir: this.hostDir, libraryPath: this.libraryPath } = testDiscFolder(root, this.runId));
  }

  private async listed(c: Controller): Promise<boolean> {
    const parent = parentOf(this.libraryPath);
    const l = await c.json<LibraryListing>(`library?path=${encodeURIComponent(parent)}`).catch(() => null);
    return !!l?.discs.some((d) => d.path === this.libraryPath);
  }

  private async rescan(c: Controller): Promise<number> {
    const at = Date.now();
    const r = await c.fetch('admin/rescan', { method: 'POST' });
    if (r.status !== 202) throw new HttpError(r.status, await r.text(), 'admin/rescan');
    return at;
  }

  private status(c: Controller): Promise<MetadataStatus> {
    return c.json<MetadataStatus>('admin/metadata/status');
  }

  /** Copies the disc into a new folder (mkdir fails if it exists), rescans, and waits until the library lists it. */
  async place(c: Controller): Promise<void> {
    if (!ownTestFolder(this.hostDir, this.runId, this.roots)) throw new Error('refusing a test folder path this run did not make');
    this.statusBefore = await this.status(c);
    // mkdir without -p: the folder must be new, so the clean-up only ever removes what this run made
    await sshRead(`mkdir -- '${this.hostDir}'`);
    this.created = true; // from here on the clean-up removes it, even when the copy below fails
    await sshUntar(`tar -C '${this.hostDir}' -xf -`);
    const files = Number((await sshRead(`find '${this.hostDir}' -type f | wc -l`)).trim());
    const listing = await new Promise<string>((res, rej) => execFile('find', [join(REPO, 'fixtures/synthetic', STORE_DISC_NAME), '-type', 'f'], (e, out) => (e ? rej(e) : res(String(out)))));
    const want = listing.trim().split('\n').length;
    if (files !== want) throw new Error(`the NAS copy has ${files} files, the fixture ${want}`);
    this.report.placed = true;
    this.log(`test disc placed at ${this.libraryPath}`);
    const at = await this.rescan(c);
    const deadline = at + 20 * 60_000;
    while (!(await this.listed(c))) {
      if (Date.now() > deadline) throw new Error('the rescan did not list the test disc in 20 minutes');
      await sleep(3000);
    }
    this.report.listedAfterMs = Date.now() - at;
    this.log(`test disc listed ${Math.round(this.report.listedAfterMs / 1000)} s after the rescan`);
  }

  /**
   * Removes exactly this run's folder (checked against the run id and the roots, and that it holds only the test disc),
   * checks it is gone, rescans, and waits until the disc is unlisted and the matcher's counts are back.
   */
  async remove(c: Controller | null): Promise<void> {
    if (!this.created || this.removed) return;
    const d = this.hostDir;
    if (!ownTestFolder(d, this.runId, this.roots)) {
      this.report.detail.push(`refused to delete ${d}: not this run's folder`);
      return;
    }
    const contents = (await sshRead(`find '${d}' -mindepth 1 -maxdepth 1 -printf '%f\\n'`).catch((e: unknown) => `ERROR ${(e as Error).message}`)).trim();
    // what this run put there: the disc's folder, or nothing yet when the copy failed
    if (contents !== STORE_DISC_NAME && contents !== '') {
      this.report.detail.push(`left ${d} in place: it holds "${contents}", not only ${STORE_DISC_NAME}`);
      return;
    }
    await sshRead(`rm -r -- '${d}'`);
    this.removed = true;
    this.report.removed = true;
    const left = (await sshRead(`test -e '${d}' && echo present || echo gone`)).trim();
    this.report.gone = left === 'gone';
    if (!this.report.gone) this.report.detail.push(`${d} is still there after rm`);
    this.log(`test folder removed (${left})`);
    if (!c) {
      this.report.detail.push('no owner session for the rescan: the nightly scan will drop the disc');
      return;
    }
    const at = await this.rescan(c);
    const deadline = at + 20 * 60_000;
    while (await this.listed(c)) {
      if (Date.now() > deadline) {
        this.report.detail.push('the rescan still lists the test disc after 20 minutes');
        return;
      }
      await sleep(3000);
    }
    this.report.unlisted = true;
    // the title run that follows the scan: filed/unsorted/music back to where they were before the disc came
    const before = this.statusBefore;
    while (Date.now() < deadline) {
      const s = await this.status(c);
      if (!s.running && (s.lastRunAt ?? 0) >= at) {
        this.report.countsRestored = !before || (s.filed === before.filed && s.unsorted === before.unsorted && s.music === before.music);
        if (!this.report.countsRestored) this.report.detail.push(`matcher counts now filed ${s.filed} / unsorted ${s.unsorted} / music ${s.music}, before ${before!.filed} / ${before!.unsorted} / ${before!.music}`);
        break;
      }
      await sleep(3000);
    }
    if (this.report.countsRestored === undefined) this.report.detail.push('no title run after the rescan within 20 minutes');
    this.log(`library rescanned: test disc unlisted; matcher counts ${this.report.countsRestored ? 'as before' : 'NOT as before'}`);
  }

  get clean(): boolean {
    return !this.created || (!!this.report.gone && !!this.report.unlisted && this.report.countsRestored !== false);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Browsers

/** Chrome through Playwright with a profile of its own: a fresh temporary profile, or a fresh context. */
class ChromeDriver implements GateDriver {
  readonly touch = false;
  private readonly log: string[] = [];
  private constructor(
    private readonly closeAll: () => Promise<void>,
    private readonly page: import('@playwright/test').Page,
    readonly via: string,
  ) {
    page.on('console', (m) => this.log.push(`${new Date().toISOString()} ${m.type()} ${m.text()}`));
  }

  static async start(kind: 'chrome-profile' | 'chrome', headless: boolean, origin: string, nasBase: string): Promise<ChromeDriver> {
    const pw = await import('@playwright/test');
    const grant = async (ctx: import('@playwright/test').BrowserContext): Promise<void> => {
      for (const o of [origin, new URL(nasBase).origin]) await ctx.grantPermissions(['local-network-access'], { origin: o }).catch(() => undefined);
    };
    if (kind === 'chrome-profile') {
      const dir = mkdtempSync(join(tmpdir(), 'live-check-profile-'));
      const ctx = await pw.chromium.launchPersistentContext(dir, { channel: 'chrome', headless, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
      await grant(ctx);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      return new ChromeDriver(async () => {
        await ctx.close();
        rmSync(dir, { recursive: true, force: true });
      }, page, `Playwright, Google Chrome with a fresh temporary profile${headless ? ' (headless)' : ''}`);
    }
    const browser = await pw.chromium.launch({ channel: 'chrome', headless });
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    await grant(ctx);
    const page = await ctx.newPage();
    return new ChromeDriver(() => browser.close(), page, `Playwright, Google Chrome ${browser.version()}, a fresh context${headless ? ' (headless)' : ''}`);
  }

  async open(url: string): Promise<void> { await this.page.goto(url); }
  evaluate<T>(e: string): Promise<T> { return this.page.evaluate(`(${e})`) as Promise<T>; }
  evaluateAsync<T>(e: string): Promise<T> { return this.page.evaluate(`Promise.resolve(${e})`) as Promise<T>; }
  async tap(x: number, y: number): Promise<void> { await this.page.mouse.click(x, y); }
  async press(key: MenuKey): Promise<void> {
    const k = ({ up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter' } as Partial<Record<MenuKey, string>>)[key];
    if (!k) throw new Error(`no keyboard key for ${key}`);
    await this.page.keyboard.press(k);
  }
  async screenshot(out: string): Promise<void> { write(out, await this.page.screenshot()); }
  async consoleLog(): Promise<string[]> { return [...this.log]; }
  close(): Promise<void> { return this.closeAll(); }
}

interface Browser {
  readonly role: string;
  readonly target: string;
  readonly person: string;
  driver: GateDriver | null;
  page: Page | null;
}

/** The pairing record in the page's IndexedDB (src/ui/nas/nas-store.ts), without creating the database. */
const READ_PAIRING = `new Promise((resolve) => { const r = indexedDB.open('bluray-web'); r.onupgradeneeded = () => r.transaction.abort();
  r.onerror = (e) => { e.preventDefault(); resolve(null); };
  r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('nas')) { db.close(); resolve(null); return; }
    const g = db.transaction('nas', 'readonly').objectStore('nas').get('pairing');
    g.onsuccess = () => { db.close(); const p = g.result; resolve(p ? { personName: p.personName ?? null, deviceName: p.deviceName, base: p.base } : null); };
    g.onerror = () => { db.close(); resolve(null); }; }; })`;

/** Forgets the pairing (only a test person's) and the test people's BD-J write-ahead records (bdj-store, `nas-person:<id>|…`). */
const forgetTest = (names: readonly string[], personIds: readonly string[]): string => `new Promise((resolve) => {
  const names = ${JSON.stringify(names)}; const ids = ${JSON.stringify(personIds)}; const done = { pairing: false, records: 0 };
  const step2 = () => { const r = indexedDB.open('bdj-store'); r.onupgradeneeded = () => r.transaction.abort(); r.onerror = (e) => { e.preventDefault(); resolve(done); };
    r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('scopes')) { db.close(); resolve(done); return; }
      const tx = db.transaction('scopes', 'readwrite'); const s = tx.objectStore('scopes'); const c = s.openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur) return; const k = String(cur.key); if (ids.some((id) => k.startsWith('nas-person:' + id + '|'))) { cur.delete(); done.records++; } cur.continue(); };
      tx.oncomplete = () => { db.close(); resolve(done); }; tx.onerror = () => { db.close(); resolve(done); }; }; };
  const r = indexedDB.open('bluray-web'); r.onupgradeneeded = () => r.transaction.abort(); r.onerror = (e) => { e.preventDefault(); step2(); };
  r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('nas')) { db.close(); step2(); return; }
    const tx = db.transaction('nas', 'readwrite'); const s = tx.objectStore('nas'); const g = s.get('pairing');
    g.onsuccess = () => { const p = g.result; if (p && names.includes(p.personName)) { s.delete('pairing'); done.pairing = true; } };
    tx.oncomplete = () => { db.close(); try { localStorage.removeItem(${JSON.stringify(FOLDER_KEY)}); } catch {} step2(); }; tx.onerror = () => { db.close(); step2(); }; }; })`;

const visible = (sel: string): string => `[...document.querySelectorAll(${JSON.stringify(sel)})].some((e) => e.getClientRects().length > 0)`;
const cssString = (s: string): string => JSON.stringify(s);

/** Scrolls the first visible match to the middle of the viewport, then taps it (a tap off screen reaches nothing). */
async function tapInView(page: Page, selector: string, during: string): Promise<void> {
  await page.until<boolean>(
    // the page's end can lie under Safari's floating toolbar: room below it (test only) lets the element reach the middle
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getClientRects().length > 0); if (!e) return false;` +
      ` document.body.style.paddingBottom = '60vh'; e.scrollIntoView({ block: 'center', inline: 'center' }); return true; })()`,
    during,
    30_000,
  );
  await sleep(400); // let a smooth scroll finish before the tap's coordinates are taken
  await page.tapOn(selector, during);
}

/**
 * A DOM click on the first visible match: for navigation that needs no user gesture (the screens move as posters
 * load, so a touch at coordinates taken a moment earlier can miss). Play stays a real touch: it starts audio.
 */
async function clickEl(page: Page, selector: string, during: string): Promise<void> {
  await page.until<boolean>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getClientRects().length > 0); if (!e) return false; e.click(); return true; })()`,
    during,
    30_000,
  );
}

interface TelemetrySnap {
  t: { bdj?: { firstFrameMs?: number | null } | null; bdjPlane?: { flushes: number; hash?: string | null } | null; framesPresented?: number } | null;
  playlist: string | null;
  bdjMenu: string | null;
  state: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

interface StoreStep {
  role: string;
  person: string;
  expected: number | null;
  shown: number | null;
  hash: string | null;
  seen: string[];
  nasMika: string | null;
  nasSora: string | null;
  ok: boolean;
  note?: string;
}

interface LibraryStep {
  n: number;
  step: string;
  held: boolean;
  ms: number;
  hash: string | null;
  playlist: string | null;
  menu: string | null;
  shot: string;
}

interface LibraryDisc {
  id: string;
  nasDiscId?: string;
  opened: boolean;
  firstFrameMs?: number | null;
  steps: LibraryStep[];
  error?: string;
  reloaded?: boolean;
}

interface Result {
  startedAt: string;
  finishedAt?: string;
  origin: string;
  devices: Record<string, string>;
  people: { created: boolean; deleted: string[]; cleanupConfirmed?: boolean; cleanupDetail?: string };
  pairings: Array<{ role: string; person: string; ok: boolean; error?: string }>;
  store: { ran: boolean; mode: 'check' | 'rehearsal' | null; skipped?: string; disc?: string; steps: StoreStep[]; pass?: boolean };
  library: { ran: boolean; skipped?: string; discs: LibraryDisc[] };
  testDisc?: { libraryPath: string; clean: boolean; placed?: boolean; listedAfterMs?: number; removed?: boolean; gone?: boolean; unlisted?: boolean; countsRestored?: boolean; detail: string[] };
  environment: Record<string, unknown>;
  errors: string[];
}

class LiveCheck {
  private readonly t0 = Date.now();
  readonly r: Result;
  readonly people: People;
  private readonly browsers: Browser[] = [];
  private readonly hashes = storeHashes();
  /** Set on Ctrl-C: no further device step starts while the clean-up runs. */
  aborted = false;
  /** disc-bdj-store placed on the NAS for this run (--store-disc place). */
  testDisc: TestDisc | null = null;

  constructor(private readonly o: Options) {
    this.people = new People(o.nas, (m) => this.log(m));
    this.r = {
      startedAt: new Date().toISOString(), origin: o.origin, devices: {}, people: { created: false, deleted: [] }, pairings: [],
      store: { ran: false, mode: null, steps: [] }, library: { ran: false, discs: [] }, environment: {}, errors: [],
    };
    const add = (role: string, target: string | null, person: string): void => {
      if (!target) return;
      this.browsers.push({ role, target, person, driver: null, page: null });
      this.r.devices[role] = target.startsWith('ios:') ? 'real device (safaridriver)' : target.startsWith('sim:') ? `Simulator ${target.slice(4)} (Appium)` : target;
    };
    add('mika-phone', o.mikaPhone, MIKA);
    add('mika-tablet', o.mikaTablet, MIKA);
    add('sora-a', o.soraA, SORA);
    add('sora-b', o.soraB, SORA);
  }

  log(msg: string): void { console.error(`[${((Date.now() - this.t0) / 1000).toFixed(1)} s] ${msg}`); }

  private browser(role: string): Browser | null { return this.browsers.find((b) => b.role === role) ?? null; }

  private async start(b: Browser): Promise<Page> {
    if (b.page) return b.page;
    const iosIndex = this.browsers.filter((x) => x.target.startsWith('ios:')).indexOf(b);
    b.driver = b.target === 'chrome-profile' || b.target === 'chrome'
      ? await ChromeDriver.start(b.target, this.o.headless, this.o.origin, this.o.nas)
      : await startTargetDriver(b.target, { driverPort: this.o.wdPorts[Math.max(0, iosIndex) % 2]!, headless: this.o.headless, touch: true, callTimeoutMs: this.o.callTimeoutMs });
    b.page = new Page(b.driver);
    this.log(`${b.role}: ${b.driver.via}`);
    return b.page;
  }

  /** Forgets the test pairing and saved data in the browser, then closes it. */
  private async stop(b: Browser): Promise<void> {
    if (!b.driver || !b.page) return;
    try {
      const ids = [this.people.mikaId, this.people.soraId].filter((x): x is string => x !== null);
      await b.page.open(`${this.o.origin}/?telemetry=1`);
      const done = await b.driver.evaluateAsync<{ pairing: boolean; records: number }>(forgetTest(TEST_NAMES, ids));
      this.log(`${b.role}: forgot the test pairing (${done.pairing ? 'removed' : 'none'}) and ${done.records} test saved-data records`);
    } catch (err) {
      this.r.errors.push(`${b.role}: forgetting the test pairing: ${(err as Error).message}`);
    }
    await b.driver.close().catch(() => undefined);
    b.driver = null;
    b.page = null;
  }

  /** Pairs the browser as `b.person` through the app's pairing screen, unless it already is. */
  private async pair(b: Browser, personId: string): Promise<void> {
    const page = await this.start(b);
    await page.open(`${this.o.origin}/?telemetry=1`);
    if (!this.r.environment[b.role]) this.r.environment[b.role] = await environment(page).catch((e: unknown) => String(e));
    const existing = await b.driver!.evaluateAsync<{ personName: string | null; deviceName: string } | null>(READ_PAIRING);
    if (existing && existing.personName === b.person) {
      this.log(`${b.role}: already paired as ${b.person}`);
      this.r.pairings.push({ role: b.role, person: b.person, ok: true });
      return;
    }
    if (existing && !TEST_NAMES.includes(existing.personName ?? '')) {
      throw new Error(`${b.role}: this browser is already paired on ${this.o.origin} as someone who is not a test person; not re-pairing it (unpair it by hand, or use another origin)`);
    }
    if (existing) await b.driver!.evaluateAsync(forgetTest(TEST_NAMES, []));
    const code = await this.people.code(personId);
    await page.open(`${this.o.origin}/?pair=${encodeURIComponent(code)}&telemetry=1`);
    await page.until(`(document.querySelector('[data-testid=pair-code]')?.value ?? '') !== ''`, 'the pairing screen', 30_000);
    await page.until(`!document.querySelector('[data-testid=pair-button]')?.disabled`, 'the pair button', 15_000);
    await tapInView(page, '[data-testid=pair-button]', 'the pair button');
    const text = await page.until<string>(
      `(() => { const e = document.querySelector('[data-testid=pair-error]'); if (e && e.getClientRects().length) return 'ERROR: ' + e.textContent; const p = document.querySelector('[data-testid=nas-paired]'); return p ? p.textContent : null; })()`,
      'the pairing',
      45_000,
    );
    if (text.startsWith('ERROR: ')) throw new Error(`${b.role}: pairing failed: ${text.slice(7)}`);
    if (!text.includes(`Paired as ${b.person}.`)) throw new Error(`${b.role}: paired as "${text}", expected ${b.person}`);
    this.log(`${b.role}: paired as ${b.person}`);
    this.r.pairings.push({ role: b.role, person: b.person, ok: true });
  }

  /** From the landing screen of a paired page: the NAS's folder browser at the disc's folder, its pre-flight, Play. */
  private async openNasDisc(page: Page, disc: DiscEntry): Promise<void> {
    await page.open(`${this.o.origin}/?telemetry=1`);
    await page.until(visible('[data-testid=nas-paired]'), 'the paired landing', 30_000);
    await page.d.evaluate(`(localStorage.setItem(${JSON.stringify(FOLDER_KEY)}, ${JSON.stringify(parentOf(disc.path))}), true)`);
    await clickEl(page, '[data-testid=nas-open]', 'Open from NAS');
    await page.until(visible('[data-testid=title-library]') + ` || ${visible('[data-testid=nas-library]')}`, 'the NAS library', 30_000);
    if (!(await page.probe<boolean>(visible('[data-testid=nas-library]'), 'the folder browser'))) await clickEl(page, '[data-testid=browse-folders]', 'Browse folders');
    const sel = `[data-testid=nas-disc][data-name=${cssString(disc.name)}]`;
    await page.until(visible(sel), 'the disc in its folder', 30_000);
    await clickEl(page, sel, 'the disc');
    await page.until(`(() => { const b = document.querySelector('[data-testid=nas-play]'); return !!b && !b.disabled; })()`, 'the pre-flight', 60_000);
    // Play is a real touch (it starts audio); when a touch misses (seen on the Simulator with the pre-flight's longer
    // "play now with pauses" page), it is tried once more, then clicked in the DOM (the picture still plays; audio may not)
    const left = `!document.querySelector('[data-testid=nas-play]') || ${visible('[data-testid=nas-play-now]')}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt < 2) await tapInView(page, '[data-testid=nas-play]', 'Play');
      else {
        this.log('Play: two touches missed; clicking it in the DOM (audio may stay muted)');
        await clickEl(page, '[data-testid=nas-play]', 'Play');
      }
      const gone = await page.until<boolean>(left, 'Play', 4000).catch((err: unknown) => {
        if (err instanceof PageReloadedError) throw err;
        return false;
      });
      if (gone) break;
    }
    // a slow link gets a buffering offer: play now
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await page.probe<boolean>(visible('[data-testid=nas-play-now]'), 'the buffering offer')) {
        await tapInView(page, '[data-testid=nas-play-now]', 'Play now with pauses');
        break;
      }
      if (await page.probe<boolean>(`!!document.querySelector('[data-testid=player]')`, 'the player')) break;
      await sleep(300);
    }
  }

  private snap(page: Page, during: string): Promise<TelemetrySnap> {
    return page.probe<TelemetrySnap>(
      "(() => { const p = document.querySelector('[data-testid=player]'); return { t: window.__blurayTelemetry ?? null, playlist: p?.getAttribute('data-playlist') ?? null, bdjMenu: p?.getAttribute('data-bdj-menu') ?? null, state: p?.getAttribute('data-state') ?? null }; })()",
      during,
    );
  }

  /** Waits until the plane has been quiet for `quietMs` on `expected` (or on any hash when null); returns the hash. */
  private async settled(page: Page, expected: string | null, quietMs: number, timeoutMs: number, seen: string[]): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let since = Date.now();
    let hash: string | null = null;
    while (Date.now() < deadline) {
      const s = await this.snap(page, 'the plane');
      const f = s.t?.bdjPlane?.flushes ?? 0;
      if (f !== last) { last = f; since = Date.now(); }
      const h = s.t?.bdjPlane?.hash ?? null;
      if (Date.now() - since >= quietMs && h !== null) {
        hash = h;
        if (seen.at(-1) !== h) seen.push(h);
        if (expected === null ? f > 0 : h === expected) return h;
      }
      await sleep(200);
    }
    return hash;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Store

  private async findStoreDisc(): Promise<DiscEntry | null> {
    const c = this.people.mika!;
    const spec = this.o.rehearseStore ?? this.o.storeDisc;
    if (spec === null) return null;
    if (/^[0-9a-f]{10}$/.test(spec)) {
      // a library-check id (map.tsv), so no disc name goes on the command line
      const host = parseMap(readFileSync(join(this.o.libraryDir, 'map.tsv'), 'utf8')).get(spec);
      const path = host ? libraryPath(host, parseRoots(readFileSync(join(REPO, 'server/deploy/compose.yaml'), 'utf8'))) : null;
      return path ? this.discAt(path) : null;
    }
    if (spec === 'place') return this.testDisc ? this.discAt(this.testDisc.libraryPath) : null;
    if (spec !== 'auto') return this.discAt(spec);
    // auto: disc-bdj-store anywhere in the top three levels of the library
    const queue: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
    while (queue.length > 0) {
      const { path, depth } = queue.shift()!;
      const l = await c.json<LibraryListing>(`library?path=${encodeURIComponent(path)}`).catch(() => null);
      if (!l) continue;
      const d = l.discs.find((x) => x.name === STORE_DISC_NAME);
      if (d) return d;
      if (depth < 2) for (const f of l.folders) queue.push({ path: f.path, depth: depth + 1 });
    }
    return null;
  }

  private async discAt(path: string): Promise<DiscEntry | null> {
    const l = await this.people.mika!.json<LibraryListing>(`library?path=${encodeURIComponent(parentOf(path))}`).catch(() => null);
    return l?.discs.find((d) => d.path === path) ?? null;
  }

  private async nasCounts(): Promise<{ mika: string | null; sora: string | null }> {
    return { mika: await this.people.mika!.storeCount(), sora: await this.people.sora!.storeCount() };
  }

  /** Polls until the person's NAS count is `want` (the 2 s NAS put after the write, with margin). */
  private async nasReaches(who: 'mika' | 'sora', want: number, timeoutMs = 30_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let v: string | null = null;
    while (Date.now() < deadline) {
      v = (await this.nasCounts())[who];
      if (v === String(want)) return v;
      await sleep(500);
    }
    return v;
  }

  async store(): Promise<void> {
    const rehearsal = this.o.rehearseStore !== null;
    this.r.store.mode = rehearsal ? 'rehearsal' : 'check';
    const disc = await this.findStoreDisc();
    if (!disc) {
      this.r.store.skipped = this.o.storeDisc === null && !rehearsal ? 'no store disc asked for (--store-disc none)' : `${rehearsal ? 'the rehearsal disc' : STORE_DISC_NAME} is not in the NAS library`;
      this.log(`store: skipped (${this.r.store.skipped})`);
      return;
    }
    this.r.store.ran = true;
    this.r.store.disc = rehearsal ? `rehearsal disc ${disc.id}` : `${STORE_DISC_NAME} (${disc.id})`;
    const start = await this.nasCounts();
    if (start.mika !== null || start.sora !== null) throw new Error(`the test people's NAS stores are not empty at the start (${JSON.stringify(start)})`);
    // [role, person, the count it must show, the NAS count it must leave]
    const plan: Array<[string, 'mika' | 'sora', number, number]> = [['mika-phone', 'mika', 0, 1], ['mika-tablet', 'mika', 1, 2], ['sora-a', 'sora', 0, 1], ['sora-b', 'sora', 1, 2]];
    for (const [role, who, shows, leaves] of plan) {
      if (this.aborted) break;
      const b = this.browser(role);
      if (!b) continue;
      const step: StoreStep = { role, person: b.person, expected: rehearsal ? null : shows, shown: null, hash: null, seen: [], nasMika: null, nasSora: null, ok: false };
      this.r.store.steps.push(step);
      try {
        await this.pair(b, who === 'mika' ? this.people.mikaId! : this.people.soraId!);
        const page = b.page!;
        await this.openNasDisc(page, disc);
        await page.until('window.__blurayTelemetry?.bdj?.firstFrameMs ?? null', "the first frame of Java's first playlist", 90_000);
        step.hash = await this.settled(page, rehearsal ? null : this.hashes[shows]!, 1500, 45_000, step.seen);
        step.shown = countOf(step.hash, this.hashes);
        await page.d.screenshot(join(this.o.out, 'store', `${role}.png`)).catch(() => undefined);
        if (!rehearsal) await this.nasReaches(who, leaves);
        else await sleep(4000); // the NAS put runs 2 s after Java's last write
        const n = await this.nasCounts();
        step.nasMika = n.mika;
        step.nasSora = n.sora;
        if (rehearsal) {
          step.ok = step.hash !== null;
          step.note = 'rehearsal: a settled plane was read; counts are not expected on this disc';
        } else {
          const mikaWant = who === 'mika' ? String(leaves) : '2';
          const soraWant = who === 'mika' ? null : String(leaves);
          step.ok = step.shown === shows && n.mika === mikaWant && n.sora === soraWant;
          if (who === 'sora' && step.shown === 2) step.note = "Sora's browser showed Mika's count";
        }
        this.log(`store ${role}: shows ${step.shown ?? step.hash} (expected ${step.expected ?? 'any'}); NAS Mika ${n.mika}, Sora ${n.sora}: ${step.ok ? 'ok' : 'FAIL'}`);
      } catch (err) {
        step.note = (err as Error).message;
        this.log(`store ${role}: ${step.note}`);
        if (b.driver) await b.driver.screenshot(join(this.o.out, 'store', `${role}-error.png`)).catch(() => undefined);
      } finally {
        await this.stop(b);
      }
    }
    this.r.store.pass = this.r.store.steps.length === 4 && this.r.store.steps.every((s) => s.ok);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Library

  /** Opens the remote without reaching the disc: a tap off the picture first (an unknown disc may take a tap on it). */
  private remoteOps(page: Page): RemoteOps {
    const base = remoteOpsFor(page, [960, 540]);
    return {
      ...base,
      tapMenu: async () => {
        const band = await page.probe<{ x: number; y: number } | null>(BAND_POINT, 'the letterbox');
        if (!band) return base.tapMenu();
        await page.d.tap(band.x, band.y);
        return 'the letterbox (off the picture)';
      },
    };
  }

  private async key(page: Page, key: MenuKey): Promise<void> {
    if (!page.d.touch) {
      await page.d.press(key);
      return;
    }
    await openRemote(this.remoteOps(page));
    await page.tapOn(`[data-testid=remote-${key}]`, `the remote's ${key}`);
  }

  /** The playlist playing when the last key was sent. */
  private beforeKeyPlaylist: string | null = null;

  /** One step of the key script, approximated from the page's telemetry (the device sees flushes and playlists late). */
  private async runStep(page: Page, s: KeyStep): Promise<boolean> {
    const at = await this.snap(page, s.text);
    const from = at.t?.bdjPlane?.flushes ?? 0;
    const t0 = Date.now();
    let last = from;
    let lastAt = Date.now();
    let menuSince: number | null = null;
    const poll = async (timeoutMs: number, held: (snap: TelemetrySnap, quietMs: number) => boolean): Promise<boolean> => {
      while (Date.now() - t0 < timeoutMs) {
        const snap = await this.snap(page, s.text);
        const f = snap.t?.bdjPlane?.flushes ?? 0;
        if (f !== last) { last = f; lastAt = Date.now(); }
        if (held(snap, Date.now() - lastAt)) return true;
        await sleep(200);
      }
      return false;
    };
    switch (s.kind) {
      case 'key':
        // a playlist the key starts can be playing before the next step begins: `wait playlist` counts from here
        this.beforeKeyPlaylist = at.playlist;
        await this.key(page, s.key);
        return true;
      case 'waitMenu':
        return poll(90_000, (snap, quiet) => {
          const shown = snap.bdjMenu === 'true';
          if (!shown) {
            menuSince = null;
            return false;
          }
          const since = (menuSince ??= Date.now());
          return quiet >= s.ms || Date.now() - since >= 30_000;
        });
      case 'waitQuiet':
        return poll(60_000, (_snap, quiet) => quiet >= s.ms);
      case 'waitStill':
        return poll(90_000, (_snap, quiet) => last > from && quiet >= s.ms);
      case 'waitFlush':
        return poll(90_000, () => last >= s.n);
      case 'waitPlaylist':
        return poll(60_000, (snap) => (s.playlist === null ? snap.playlist !== null && snap.playlist !== '' && snap.playlist !== (this.beforeKeyPlaylist ?? at.playlist) : snap.playlist === String(s.playlist).padStart(5, '0')));
      case 'pointer':
        return false;
    }
  }

  async library(): Promise<void> {
    const b = this.browser('mika-phone');
    if (!this.o.library) {
      this.r.library.skipped = 'not asked for (--library)';
      return;
    }
    if (!b) {
      this.r.library.skipped = 'no --mika-phone';
      return;
    }
    const map = parseMap(readFileSync(join(this.o.libraryDir, 'map.tsv'), 'utf8'));
    const roots = parseRoots(readFileSync(join(REPO, 'server/deploy/compose.yaml'), 'utf8'));
    const steps = parseKeyScript(readFileSync(join(REPO, 'tools/bdj-library/generic.keys'), 'utf8'));
    this.r.library.ran = true;
    try {
      await this.pair(b, this.people.mikaId!);
      const page = b.page!;
      for (const id of this.o.discs) {
        if (this.aborted) break;
        const rec: LibraryDisc = { id, opened: false, steps: [] };
        this.beforeKeyPlaylist = null;
        this.r.library.discs.push(rec);
        const dir = join(this.o.out, id);
        try {
          const host = map.get(id);
          if (!host) throw new Error('not in map.tsv');
          const path = libraryPath(host, roots);
          if (!path) throw new Error('its folder is in no library root');
          const disc = await this.discAt(path);
          if (!disc) throw new Error('the NAS library does not list it');
          rec.nasDiscId = disc.id;
          await this.openNasDisc(page, disc);
          rec.firstFrameMs = await page.until<number>('window.__blurayTelemetry?.bdj?.firstFrameMs ?? null', "the first frame of Java's first playlist", 120_000);
          rec.opened = true;
          await page.d.screenshot(join(dir, '00-opened.png')).catch(() => undefined);
          for (const [n, s] of steps.entries()) {
            const t = Date.now();
            const held = await this.runStep(page, s);
            const snap = await this.snap(page, s.text);
            const shot = join(dir, `${String(n + 1).padStart(2, '0')}-${s.text.replace(/[^A-Za-z0-9]+/g, '-')}.png`);
            await page.d.screenshot(shot).catch(() => undefined);
            rec.steps.push({ n, step: s.text, held, ms: Date.now() - t, hash: snap.t?.bdjPlane?.hash ?? null, playlist: snap.playlist, menu: snap.bdjMenu, shot: relative(this.o.out, shot) });
            this.log(`${id}: ${s.text}: ${held ? 'held' : 'NOT HELD'} (playlist ${snap.playlist}, menu ${snap.bdjMenu})`);
          }
          await sleep(3000);
          await page.d.screenshot(join(dir, '99-end.png')).catch(() => undefined);
        } catch (err) {
          rec.error = (err as Error).message;
          rec.reloaded = err instanceof PageReloadedError;
          this.log(`${id}: ${rec.error}`);
          await page.d.screenshot(join(dir, 'error.png')).catch(() => undefined);
          if (rec.reloaded) await page.open(`${this.o.origin}/?telemetry=1`).catch(() => undefined);
        }
        write(join(dir, 'result.json'), `${JSON.stringify(rec, null, 2)}\n`);
      }
    } finally {
      await this.stop(b);
    }
  }

  /** Closes every browser still open (forgetting its test pairing). */
  async stopAll(): Promise<void> {
    for (const b of this.browsers) await this.stop(b).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const o = parseLiveArgs(process.argv.slice(2));
  if (!existsSync(join(REPO, 'tests/bdj/golden/disc-bdj-store.open.1.jsonl'))) throw new Error('the disc-bdj-store goldens are missing');
  const check = new LiveCheck(o);
  let cleaning: Promise<void> | null = null;
  const cleanUp = (): Promise<void> =>
    (cleaning ??= (async () => {
      await check.stopAll();
      // the test disc first: its rescan needs Mika's owner session, which goes with Mika
      const disc = check.testDisc;
      if (disc) {
        await disc.remove(check.people.mika).catch((e: unknown) => disc.report.detail.push(`removing the test disc: ${(e as Error).message}`));
        check.r.testDisc = { libraryPath: disc.libraryPath, clean: disc.clean, ...disc.report };
        check.log(`test disc: ${disc.clean ? 'removed and unlisted' : `NOT CLEAN: ${disc.report.detail.join('; ')}`}`);
      }
      const c = await check.people.cleanUp().catch((e: unknown) => ({ confirmed: false, detail: `clean-up failed: ${(e as Error).message}` }));
      check.r.people.deleted = check.people.deleted;
      check.r.people.cleanupConfirmed = c.confirmed;
      check.r.people.cleanupDetail = c.detail;
      check.r.finishedAt = new Date().toISOString();
      write(join(o.out, 'live-check.json'), `${JSON.stringify(check.r, null, 2)}\n`);
      check.log(`clean-up: ${c.confirmed ? 'confirmed' : 'NOT CONFIRMED'}: ${c.detail}`);
    })());
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      check.aborted = true;
      check.log(`${sig}: cleaning up before exiting`);
      void cleanUp().finally(() => process.exit(130));
    });
  }
  let failed = false;
  try {
    await check.people.setUp();
    check.r.people.created = true;
    if (o.storeDisc === 'place' && o.rehearseStore === null) {
      check.testDisc = new TestDisc(o.placeRoot, (m) => check.log(m));
      await check.testDisc.place(check.people.mika!);
    }
    await check.store();
    await check.library();
  } catch (err) {
    failed = true;
    check.r.errors.push((err as Error).message);
    check.log(`error: ${(err as Error).message}`);
  } finally {
    await cleanUp();
  }
  const r = check.r;
  console.error(
    `store: ${r.store.ran ? (r.store.mode === 'rehearsal' ? `rehearsed (${r.store.steps.filter((s) => s.ok).length}/${r.store.steps.length} planes read)` : r.store.pass ? 'PASS' : 'FAIL') : `skipped (${r.store.skipped})`}; ` +
      `library: ${r.library.ran ? `${r.library.discs.filter((d) => d.opened).length}/${r.library.discs.length} opened` : `skipped (${r.library.skipped})`}; ` +
      `${r.testDisc ? `test disc: ${r.testDisc.clean ? 'removed' : 'NOT CLEAN'}; ` : ''}people deleted: ${r.people.cleanupConfirmed ? 'confirmed' : 'NOT CONFIRMED'} → ${join(o.out, 'live-check.json')}`,
  );
  process.exit(failed || !r.people.cleanupConfirmed || (r.testDisc && !r.testDisc.clean) || (r.store.ran && r.store.mode === 'check' && !r.store.pass) ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
