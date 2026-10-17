import { readFileSync } from 'node:fs';
import { compareBdjTraces } from './compare';
import { CONTROL_CALLS, parseBdjTrace, type TraceEntry } from './format';
import { parseKeyScript, parseScriptOptions, type ScriptOptions, type SettledStep } from './key-script';
import { replayPlayerBdj, type PlayerBdjReplay } from './replay-player';

/**
 * libbluray's run of a key script (tools/bdj-trace/golden.sh, reduced by tools/bdj-trace/settled.py): the control
 * calls, each step with the settled plane's hash at its `wait still` steps, and the last flushed plane.
 */
export interface SettledGolden {
  readonly calls: TraceEntry[];
  readonly steps: SettledStep[];
  readonly endHash: string | null;
}

export function parseSettledGolden(text: string): SettledGolden {
  const lines = text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
  const end = lines.find((l) => l.script === 'end');
  if (!end) throw new Error('settled golden: no end line');
  return {
    calls: parseBdjTrace(text),
    steps: lines.filter((l) => l.script === 'step') as unknown as SettledStep[],
    endHash: end.hash as string | null,
  };
}

const controlCount = (t: readonly TraceEntry[]): number => t.filter((e) => CONTROL_CALLS.has(e.call)).length;

/**
 * Where a replay of the golden's script stops: once ours has as many control calls as the golden, counted as the script's
 * options restrict them (the golden runs past the script's last step, so it has every call the run makes).
 */
export function untilGolden(g: SettledGolden, options: ScriptOptions): { until: string; untilTrace: (trace: readonly TraceEntry[]) => boolean } {
  const want = controlCount(g.calls);
  if (want === 0) throw new Error('settled golden: no control calls');
  let seen = 0;
  let n = 0;
  return {
    until: '-',
    untilTrace: (trace) => {
      for (; seen < trace.length; seen++) n += controlCount(restrict([trace[seen]!], options));
      return n >= want;
    },
  };
}

/**
 * The script's restricted checks applied to a trace: writes of timing-dependent GPRs are left out, as settled.py leaves
 * them out of the golden (their values and how many fall before the run ends depend on timing).
 */
function restrict(trace: readonly TraceEntry[], options: ScriptOptions): TraceEntry[] {
  const vary = new Set(options.varyGprs);
  return trace.filter((e) => !(e.call === 'writeRegN' && e.args[0] === 0 && vary.has(Number(e.args[1]))));
}

/**
 * How our scripted run differs from libbluray's settled golden, one line per difference (none: they match): the control
 * calls in order and of equal count (restricted as the script's options say), every step with its settled plane hash,
 * the last flushed plane, and no BD-J failure.
 */
export function diffSettled(g: SettledGolden, run: PlayerBdjReplay, options: ScriptOptions = { varyGprs: [] }): string[] {
  const out: string[] = [];
  try {
    compareBdjTraces(restrict(g.calls, options), restrict(run.trace, options));
  } catch (e) {
    out.push(e instanceof Error ? e.message : String(e));
  }
  // compareBdjTraces checks a prefix; the golden runs past the script's last step, so it has every call, and ours none more
  const ours = controlCount(restrict(run.trace, options));
  if (ours !== controlCount(g.calls)) out.push(`control calls: libbluray ${controlCount(g.calls)}, ours ${ours}`);
  for (let i = 0; i < Math.max(g.steps.length, run.steps.length); i++) {
    const a = JSON.stringify(g.steps[i]) ?? '-';
    const b = JSON.stringify(run.steps[i]) ?? '-';
    if (a !== b) out.push(`step ${i}: libbluray ${a}, ours ${b}`);
  }
  const end = run.flushes.at(-1) ?? null;
  if (end !== g.endHash) out.push(`end plane: libbluray ${g.endHash}, ours ${end}`);
  if (run.events.some((e) => e.type === 'notice' && e.code === 'bdj-failed')) out.push('BD-J failed in our run');
  return out;
}

/**
 * Replays a key script through the real Player and compares it with libbluray's settled golden (diffSettled); throws
 * with every difference. Flush by flush the runs differ legitimately: libbluray's BDRootWindow flushes on a 40 ms timer
 * and menus animate on the wall clock, so how many flushes a change takes depends on timing, in libbluray's runs as in
 * ours (Ruling R3: settled points, not flush numbers).
 */
export async function replaySettled(
  disc: URL | string,
  goldenFile: URL | string,
  scriptFile: URL | string,
  extra: Partial<Parameters<typeof replayPlayerBdj>[1]> = {},
): Promise<{ run: PlayerBdjReplay; golden: SettledGolden }> {
  const g = parseSettledGolden(readFileSync(goldenFile, 'utf8'));
  const source = readFileSync(scriptFile, 'utf8');
  const options = parseScriptOptions(source);
  const run = await replayPlayerBdj(disc, { ...untilGolden(g, options), script: parseKeyScript(source), timeoutMs: 170_000, ...extra });
  const diff = diffSettled(g, run, options);
  if (diff.length) throw new Error(`our run differs from libbluray's:\n  ${diff.join('\n  ')}`);
  return { run, golden: g };
}
