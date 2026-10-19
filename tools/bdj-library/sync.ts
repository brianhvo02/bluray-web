/**
 * npm run bdj-library:sync -- [--roots auto|<dir>,<dir>...] [--host H] [--dry-run]
 *
 * Finds the BD-J discs on the NAS (a folder whose BDMV/BDJO holds a .bdjo file and whose BDMV/index.bdmv exists) and
 * copies each one's start-up files (BDMV without STREAM, and CERTIFICATE) to $BDJ_LIBRARY_DIR/discs/<id>/, then writes
 * one stub .m2ts per clip so the player's readability check passes and every playlist ends at once. Read-only on the
 * NAS: every find and tar runs under `ionice -c3 nice -n19`, STREAM is pruned (never read), copies run one at a time.
 * Incremental: a disc whose NAS file list (path, size, mtime) is unchanged since its last copy is skipped; an existing
 * copy without a recorded list is adopted when its file sizes match. See tools/bdj-library/README.md.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { indexUsesBdj, parseIndex } from '../../src/engine/bdmv/index-parser';
import { discId, libraryDir } from './classify';

const NICE = 'ionice -c3 nice -n19';
/** How long one remote listing or one disc's copy may take before it is killed and reported. */
const REMOTE_TIMEOUT_MS = 10 * 60_000;
const COPY_TIMEOUT_MS = 10 * 60_000;

/** Single-quotes a string for a POSIX shell. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Runs `bash -c script` on the host over ssh with `input` on stdin; resolves with stdout (bytes). */
function remote(host: string, script: string, input = ''): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', host, `bash -c ${shq(script)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, REMOTE_TIMEOUT_MS);
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`ssh ${host}: no answer within ${REMOTE_TIMEOUT_MS / 60_000} min; killed`));
      else if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ssh ${host}: exit ${code}: ${err.slice(0, 300)}`));
    });
    p.stdin.end(input);
  });
}

/** The library roots: the given ones, or (auto) every /mnt/drv* folder on the host. */
async function roots(host: string, arg: string): Promise<string[]> {
  if (arg !== 'auto') return arg.split(',').filter(Boolean);
  const out = (await remote(host, 'for d in /mnt/drv*/; do [ -d "$d" ] && printf "%s\\0" "${d%/}"; done')).toString('utf8');
  return out.split('\0').filter(Boolean);
}

/** Disc folders under the roots that have BDMV/index.bdmv and a BDMV/BDJO/*.bdjo (STREAM and BACKUP pruned). */
async function findDiscs(host: string, rootDirs: readonly string[]): Promise<string[]> {
  const script = `${NICE} find "$@" \\( -path '*/BDMV/STREAM' -o -path '*/BDMV/BACKUP' \\) -prune -o -type f \\( -path '*/BDMV/index.bdmv' -o -path '*/BDMV/BDJO/*.bdjo' \\) -print0 2>/dev/null; [ $? -le 1 ]`; // 1: some folders unreadable (lost+found)
  const out = (await remote(host, `set -- ${rootDirs.map(shq).join(' ')}; ${script}`)).toString('utf8');
  const index = new Set<string>();
  const bdjo = new Set<string>();
  for (const p of out.split('\0')) {
    if (p.endsWith('/BDMV/index.bdmv')) index.add(p.slice(0, -'/BDMV/index.bdmv'.length));
    else {
      const i = p.lastIndexOf('/BDMV/BDJO/');
      if (i > 0) bdjo.add(p.slice(0, i));
    }
  }
  return [...bdjo].filter((d) => index.has(d)).sort();
}

/** Each disc's file list on the host: `<relative path>\t<size>\t<mtime s>` lines, sorted (STREAM pruned). */
async function listings(host: string, discs: readonly string[]): Promise<Map<string, string>> {
  const script = `while IFS= read -r -d '' d; do printf '\\1%s\\0' "$d"; cd "$d" 2>/dev/null || continue; set -- BDMV; [ -d CERTIFICATE ] && set -- BDMV CERTIFICATE; ${NICE} find "$@" -path BDMV/STREAM -prune -o -type f -printf '%p\\t%s\\t%T@\\0'; done`;
  const out = (await remote(host, script, discs.map((d) => `${d}\0`).join(''))).toString('utf8');
  const map = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const rec of out.split('\0')) {
    if (rec.startsWith('\u0001')) map.set(rec.slice(1), (cur = []));
    else if (rec && cur) {
      const [path, size, mtime] = rec.split('\t');
      cur.push(`${path}\t${size}\t${Math.floor(Number(mtime))}`);
    }
  }
  return new Map([...map].map(([d, lines]) => [d, lines.sort().join('\n') + '\n']));
}

/** Copies one disc's BDMV (without STREAM) and CERTIFICATE with tar over ssh (the path goes on stdin). */
function copyDisc(host: string, disc: string, dest: string): Promise<void> {
  const script = `IFS= read -r d; cd "$d" || exit 3; set -- BDMV; [ -d CERTIFICATE ] && set -- BDMV CERTIFICATE; ${NICE} tar -cf - --exclude=BDMV/STREAM --exclude=BDMV/BACKUP/STREAM "$@"`;
  return new Promise((resolve, reject) => {
    mkdirSync(dest, { recursive: true });
    const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', host, `bash -c ${shq(script)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-xf', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ssh.kill('SIGKILL');
      tar.kill('SIGKILL');
    }, COPY_TIMEOUT_MS);
    ssh.stdout.pipe(tar.stdin);
    let err = '';
    ssh.stderr.on('data', (d: Buffer) => (err += d.toString()));
    tar.stderr.on('data', (d: Buffer) => (err += d.toString()));
    let left = 2;
    let failed = false;
    const done = (code: number | null): void => {
      if (code !== 0) failed = true;
      if (--left > 0) return;
      clearTimeout(timer);
      if (timedOut) reject(new Error(`copy not done within ${COPY_TIMEOUT_MS / 60_000} min; killed`));
      else if (failed) reject(new Error(`copy failed: ${err.slice(0, 300)}`));
      else resolve();
    };
    ssh.on('close', done);
    tar.on('close', done);
    ssh.stdin.end(`${disc}\n`);
  });
}

/** Local file sizes of a copy, as `<relative path>\t<size>` (STREAM left out). */
function localSizes(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (rel === join('BDMV', 'STREAM')) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(rel, statSync(p).size);
    }
  };
  for (const top of ['BDMV', 'CERTIFICATE']) if (existsSync(join(dir, top))) walk(join(dir, top));
  return out;
}

/** Whether a local copy holds exactly the listed files at the listed sizes. */
function matches(dir: string, listing: string): boolean {
  const local = localSizes(dir);
  const lines = listing.trim().split('\n').filter(Boolean);
  if (lines.length !== local.size) return false;
  return lines.every((l) => {
    const [p, size] = l.split('\t');
    return local.get(p!) === Number(size);
  });
}

/** One aligned unit (32 source packets) of null TS packets per clip under BDMV/STREAM (tools/bdj-library/README.md). */
export function writeStubStreams(dir: string): void {
  const unit = new Uint8Array(6144);
  for (let k = 0; k < 32; k++) {
    unit.set([0x47, 0x1f, 0xff, 0x10], k * 192 + 4);
    unit.fill(0xff, k * 192 + 8, k * 192 + 192);
  }
  const clipinf = join(dir, 'BDMV', 'CLIPINF');
  const stream = join(dir, 'BDMV', 'STREAM');
  mkdirSync(stream, { recursive: true });
  if (!existsSync(clipinf)) return;
  for (const f of readdirSync(clipinf)) {
    const m = /^(\d{5})\.clpi$/i.exec(f);
    if (!m) continue;
    const p = join(stream, `${m[1]}.m2ts`);
    if (!existsSync(p)) writeFileSync(p, unit);
  }
}

/** Whether the copy's index.bdmv names a BD-J object (false when unreadable). */
function usesBdj(dir: string): boolean {
  try {
    return indexUsesBdj(parseIndex(new Uint8Array(readFileSync(join(dir, 'BDMV', 'index.bdmv')))));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (name: string, dflt: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
  };
  const host = opt('--host', process.env.BDJ_LIBRARY_HOST ?? 'mediaserver');
  const dry = argv.includes('--dry-run');
  const lib = libraryDir();
  const discsDir = join(lib, 'discs');
  const manifests = join(lib, 'manifests');
  mkdirSync(discsDir, { recursive: true });
  mkdirSync(manifests, { recursive: true });
  const t0 = Date.now();

  const rootDirs = await roots(host, opt('--roots', 'auto'));
  console.log(`roots: ${rootDirs.length}`);
  const found = await findDiscs(host, rootDirs);
  console.log(`BD-J discs found: ${found.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
  const lists = await listings(host, found);
  const rows: string[] = [];
  const counts = { copied: 0, adopted: 0, unchanged: 0, failed: 0, notBdj: 0 };
  for (const disc of found) {
    const id = discId(disc);
    const listing = lists.get(disc);
    const dest = join(discsDir, id);
    const manifest = join(manifests, `${id}.tsv`);
    if (!listing) {
      console.log(`${id} unreadable on the NAS`);
      counts.failed++;
      continue;
    }
    const recorded = existsSync(manifest) ? readFileSync(manifest, 'utf8') : null;
    if (recorded === listing && existsSync(join(dest, 'BDMV', 'index.bdmv'))) counts.unchanged++;
    else if (recorded === null && existsSync(dest) && matches(dest, listing)) {
      if (!dry) writeFileSync(manifest, listing);
      counts.adopted++;
      console.log(`${id} adopted`);
    } else if (dry) {
      console.log(`${id} would copy`);
    } else {
      const tmp = join(discsDir, `.tmp-${id}`);
      rmSync(tmp, { recursive: true, force: true });
      try {
        await copyDisc(host, disc, tmp);
        if (!matches(tmp, listing)) throw new Error('the copy does not match the NAS file list');
        rmSync(dest, { recursive: true, force: true });
        renameSync(tmp, dest);
        writeFileSync(manifest, listing);
        counts.copied++;
        console.log(`${id} copied`);
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        counts.failed++;
        console.log(`${id} failed: ${(e as Error).message.replace(/\/[^\s:]*/g, '<path>')}`);
        continue;
      }
    }
    if (dry && !existsSync(dest)) continue;
    if (!dry) writeStubStreams(dest);
    const bdj = usesBdj(dest);
    if (!bdj) counts.notBdj++;
    rows.push([id, bdj ? 1 : 0, createHash('sha1').update(listing).digest('hex').slice(0, 12), disc].join('\t'));
  }
  if (!dry) writeFileSync(join(lib, 'map.tsv'), `id\tbdj\tfingerprint\tpath\n${rows.join('\n')}\n`);
  const known = new Set(found.map(discId));
  const gone = existsSync(discsDir) ? readdirSync(discsDir).filter((d) => /^[0-9a-f]{10}$/.test(d) && !known.has(d)) : [];
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(counts)}${gone.length ? `; ${gone.length} local copies no longer on the NAS: ${gone.join(' ')}` : ''}`);
}

await main();
