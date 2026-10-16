/**
 * The ASS trace harness from Node.
 *   tsx tests/ass-trace/run.ts normalize <in.jsonl> <out.jsonl>          re-formats a raw libass trace
 *   tsx tests/ass-trace/run.ts png <in dir> <out dir>                      converts <ms>.rgba frames to <ms>.png
 *   tsx tests/ass-trace/run.ts <file.ass> <fonts dir> <times file> [WxH]  traces any file into tools/ass-trace/out/<name>/
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { formatTrace, parseTrace } from './format';
import { encodePng } from './png';

const WIDTH = 1920;
const HEIGHT = 1080;

/** Raw .rgba frames (older harness builds) to PNG. */
export function convertFrames(inDir: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(inDir).filter((n) => n.endsWith('.rgba'))) {
    writeFileSync(join(outDir, f.replace(/\.rgba$/, '.png')), encodePng(WIDTH, HEIGHT, new Uint8Array(readFileSync(join(inDir, f)))));
  }
}

/** Runs the harness on a script; returns the normalized trace and leaves PNG frames in `outDir`. */
export function traceScript(script: string, fonts: string, times: string, outDir: string, storage?: string): string {
  mkdirSync(outDir, { recursive: true });
  const stdout = execFileSync('tools/ass-trace/run.sh', [script, fonts, times, outDir, ...(storage ? [storage] : [])], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const trace = formatTrace(parseTrace(stdout));
  writeFileSync(join(outDir, 'trace.jsonl'), trace);
  return trace;
}

if (process.argv[1]?.endsWith('run.ts')) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'normalize' && a && b) writeFileSync(b, formatTrace(parseTrace(readFileSync(a, 'utf8'))));
  else if (cmd === 'png' && a && b) convertFrames(a, b);
  else if (cmd && a && b) {
    const out = join('tools/ass-trace/out', basename(cmd, '.ass'));
    traceScript(cmd, a, b, out, c);
    console.log(`wrote ${out}/trace.jsonl and its frames`);
  } else {
    console.error('usage: run.ts normalize <in> <out> | png <in dir> <out dir> | <file.ass> <fonts dir> <times file> [WxH]');
    process.exit(2);
  }
}
