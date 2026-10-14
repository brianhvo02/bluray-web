import type { TraceEntry } from './format';

const CONTEXT = 5;

/** Entries compare on kind and values; `t` (diagnostic time) is ignored. */
function sameEntry(a: TraceEntry | undefined, b: TraceEntry | undefined): boolean {
  if (!a || !b) return a === b;
  const strip = (e: TraceEntry): string => JSON.stringify({ ...e, t: undefined });
  return strip(a) === strip(b);
}

function show(entries: readonly TraceEntry[], at: number): string {
  const lines: string[] = [];
  for (let i = Math.max(0, at - CONTEXT); i <= Math.min(entries.length - 1, at + CONTEXT); i++) {
    lines.push(`${i === at ? '>>' : '  '} ${String(i).padStart(4)}  ${JSON.stringify(entries[i])}`);
  }
  if (at >= entries.length) lines.push(`>>       (trace ends after ${entries.length} entries)`);
  return lines.join('\n');
}

/** Throws at the first entry that differs, naming the script step and showing five entries around it on each side. */
export function compareTraces(expected: readonly TraceEntry[], actual: readonly TraceEntry[]): void {
  const length = Math.max(expected.length, actual.length);
  for (let i = 0; i < length; i++) {
    if (sameEntry(expected[i], actual[i])) continue;
    const step = expected.slice(0, i).filter((e) => e.k === 'step').length;
    throw new Error(
      `trace diverges at entry ${i}, during script step ${step}\nlibbluray:\n${show(expected, i)}\nours:\n${show(actual, i)}`,
    );
  }
}
