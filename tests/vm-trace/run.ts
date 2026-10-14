/** npm run vm-trace -- <disc> <script>: runs libbluray (Docker) and our replay live on fixtures/synthetic/<disc> and prints the first divergence. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareTraces } from './compare';
import { parseTrace } from './format';
import { replay } from './replay';

const [disc, script] = process.argv.slice(2);
if (!disc || !script) {
  console.error('usage: npm run vm-trace -- <disc> <script>   (e.g. disc-vm boot)');
  process.exit(2);
}

const root = new URL('../../', import.meta.url);
const keys = readFileSync(new URL(`tests/vm-trace/scripts/${disc}.${script}.keys`, root), 'utf8');
const golden = parseTrace(execFileSync(fileURLToPath(new URL('tools/vm-trace/run.sh', root)), [disc, script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
const ours = await replay(new URL(`fixtures/synthetic/${disc}`, root), keys);

try {
  compareTraces(golden, ours);
  console.log(`${disc}.${script}: ${golden.length} entries match`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
