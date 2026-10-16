import { isDeepStrictEqual } from 'node:util';
import { CONTROL_CALLS } from './format';
import type { TraceEntry } from './format';

const control = (t: readonly TraceEntry[]): TraceEntry[] => t.filter((e) => CONTROL_CALLS.has(e.call));
const show = (e: TraceEntry | undefined): string => (e ? JSON.stringify({ call: e.call, args: e.args, ret: e.ret }) : '(missing)');

/** Compares control calls in order and by value; our extra trailing calls after the golden's last are ignored. */
export function compareBdjTraces(golden: readonly TraceEntry[], ours: readonly TraceEntry[]): void {
  const g = control(golden);
  const o = control(ours);
  for (let i = 0; i < g.length; i++) {
    const a = g[i]!;
    const b = o[i];
    if (!b || a.call !== b.call || !isDeepStrictEqual(a.args, b.args) || !isDeepStrictEqual(a.ret, b.ret)) {
      throw new Error(`BD-J trace diverges at control call ${i} (${a.call}):\n  golden: ${show(a)}\n  ours:   ${show(b)}`);
    }
  }
}
