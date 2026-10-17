/**
 * npm run bdj-trace -- <disc> [--until <call>[#<n>]] [--seconds N] [--libbluray FILE]: runs real libbluray
 * (tools/bdj-trace/run.sh, Docker) and our side on the same disc, prints both control-call sequences side by side, the
 * first divergence, and our times. Exits 1 on a divergence.
 *   <disc>            a folder name under fixtures/synthetic, or a path to a disc folder (the one holding BDMV/)
 *   --until CALL[#N]  stop both runs right after the N-th (default first) CALL (e.g. selectPlaylistN#2); our side is
 *                     the real Player with BD-J on a virtual clock (replayPlayerBdj), so playlists end as they play
 *   --seconds N       without --until: how long both runs go on (default 60); our side is the recording host (replayBdj)
 *   --libbluray FILE  compare against a saved run.sh output instead of running Docker (libbluray reads in real time)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareBdjTraces } from './compare';
import { CONTROL_CALLS, parseBdjTrace } from './format';
import type { TraceEntry } from './format';
import { replayBdj } from './replay';
import { replayPlayerBdj } from './replay-player';

const USAGE = 'usage: npm run bdj-trace -- <disc> [--until <call>[#<n>]] [--seconds N] [--libbluray FILE]   (e.g. fixtures/local/X --until selectPlaylistN#2)';

function parseArgs(argv: readonly string[]): { disc: string; until?: string; seconds: number; libbluray?: string } {
  let disc: string | undefined;
  let until: string | undefined;
  let libbluray: string | undefined;
  let seconds = 60;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--until' && argv[i + 1]) until = argv[++i];
    else if (a === '--seconds' && argv[i + 1]) seconds = Number(argv[++i]);
    else if (a === '--libbluray' && argv[i + 1]) libbluray = argv[++i];
    else if (!a.startsWith('--') && disc === undefined) disc = a;
    else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!disc || !(seconds > 0) || (until !== undefined && !/^\w+(#[1-9]\d*)?$/.test(until))) {
    console.error(USAGE);
    process.exit(2);
  }
  return { disc, seconds, ...(until === undefined ? {} : { until }), ...(libbluray === undefined ? {} : { libbluray }) };
}

const show = (e: TraceEntry | undefined): string => (e ? `${e.call}(${e.args.map((a) => JSON.stringify(a)).join(', ')}) = ${JSON.stringify(e.ret)}` : '-');

/** Both control-call sequences in two columns, `!` marking rows that differ. */
function sideBySide(golden: readonly TraceEntry[], ours: readonly TraceEntry[]): string {
  const g = golden.filter((e) => CONTROL_CALLS.has(e.call)).map(show);
  const o = ours.filter((e) => CONTROL_CALLS.has(e.call)).map(show);
  const width = Math.max('libbluray'.length, ...g.map((s) => s.length));
  const rows = [`     ${'libbluray'.padEnd(width)} | ours`];
  for (let i = 0; i < Math.max(g.length, o.length); i++) {
    const a = g[i] ?? '-';
    const b = o[i] ?? '-';
    rows.push(`${a === b || g[i] === undefined ? ' ' : '!'}${String(i).padStart(3)} ${a.padEnd(width)} | ${b}`);
  }
  return rows.join('\n');
}

const { disc, until, seconds, libbluray } = parseArgs(process.argv.slice(2));
const root = new URL('../../', import.meta.url);
const isDir = existsSync(disc) && statSync(disc).isDirectory();
const discDir = isDir ? resolve(disc) : fileURLToPath(new URL(`fixtures/synthetic/${disc}/`, root));
const name = basename(discDir);
const [untilCall, untilN] = until === undefined ? [undefined, 1] : [until.split('#')[0]!, Number(until.split('#')[1] ?? 1)];

const harnessArgs = [isDir ? discDir : disc, ...(until ? ['--until', until] : []), '--seconds', String(seconds)];
const golden = parseBdjTrace(
  libbluray !== undefined
    ? readFileSync(libbluray, 'utf8')
    : execFileSync(fileURLToPath(new URL('tools/bdj-trace/run.sh', root)), harnessArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }),
);

let ours: TraceEntry[] = [];
let times = '';
let failure: unknown = null;
try {
  if (untilCall === undefined) {
    const r = await replayBdj(discDir, { timeoutMs: seconds * 1000 });
    ours = r.trace;
    times = `bootMs ${r.bootMs.toFixed(0)}, untilMs ${r.untilMs.toFixed(0)}`;
  } else {
    const r = await replayPlayerBdj(discDir, { until: untilCall, occurrence: untilN, timeoutMs: 300_000 });
    ours = r.trace;
    times = `firstPlaylistMs ${r.firstPlaylistMs.toFixed(0)}, untilMs ${r.untilMs.toFixed(0)}, virtualMs ${r.virtualMs.toFixed(0)}`;
  }
} catch (e) {
  failure = e;
  ours = (e as { trace?: TraceEntry[] }).trace ?? [];
}

console.log(`${name}: control calls\n${sideBySide(golden, ours)}\n`);
let diverged = false;
try {
  compareBdjTraces(golden, ours);
  const n = golden.filter((e) => CONTROL_CALLS.has(e.call)).length;
  console.log(`${name}: ${n} control calls match${until ? ` up to and including ${until}` : ''}`);
} catch (e) {
  diverged = true;
  console.error(e instanceof Error ? e.message : e);
}
if (failure) console.error(`${name}: our run failed: ${failure instanceof Error ? failure.message : String(failure)}`);
if (times) console.log(`${name}: ${times}`);
process.exit(diverged || failure ? 1 : 0);
