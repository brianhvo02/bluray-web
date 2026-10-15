/**
 * npm run vm-trace -- <disc> <script> [--dump-pages]: runs libbluray (Docker) and our replay live and prints the first divergence.
 *   <disc>    a folder name under fixtures/synthetic, or a path to a disc folder (the one holding BDMV/), e.g. fixtures/local/X
 *   <script>  a script name (tests/vm-trace/scripts/<disc>.<script>.keys), or a path to a .keys file
 *   --dump-pages  prints every IG menu the replay reads (pages, buttons, rectangles, commands) to stderr
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareTraces } from './compare';
import { parseTrace } from './format';
import { replay } from './replay';

const args = process.argv.slice(2);
const dumpPages = args.includes('--dump-pages');
const [disc, script] = args.filter((a) => a !== '--dump-pages');
if (!disc || !script) {
  console.error('usage: npm run vm-trace -- <disc> <script> [--dump-pages]   (e.g. disc-vm boot)');
  process.exit(2);
}

const root = new URL('../../', import.meta.url);
const isDir = existsSync(disc) && statSync(disc).isDirectory();
const discDir = isDir ? pathToFileURL(`${resolve(disc)}/`) : new URL(`fixtures/synthetic/${disc}/`, root);
const scriptFile = existsSync(script) && statSync(script).isFile()
  ? resolve(script)
  : fileURLToPath(new URL(`tests/vm-trace/scripts/${basename(fileURLToPath(discDir))}.${script}.keys`, root));
const keys = readFileSync(scriptFile, 'utf8');
const golden = parseTrace(execFileSync(fileURLToPath(new URL('tools/vm-trace/run.sh', root)), [isDir ? resolve(disc) : disc, scriptFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 }));
const ours = await replay(discDir, keys, dumpPages ? { dumpPages: (text) => console.error(text) } : {});

try {
  compareTraces(golden, ours);
  console.log(`${basename(fileURLToPath(discDir))} ${basename(scriptFile)}: ${golden.length} entries match`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
