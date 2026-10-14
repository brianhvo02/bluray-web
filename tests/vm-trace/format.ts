/** One line of a libbluray/replay trace (JSON lines). `t` is diagnostic only and never compared. */
export type TraceEntry =
  | { k: 'gpr' | 'psr'; i: number; v: number; t?: number } // register writes (PSR 8 TIME excluded on both sides: time-dependent)
  | { k: 'title'; v: number; t?: number } | { k: 'playlist'; v: number; t?: number } | { k: 'playitem'; v: number; t?: number } | { k: 'chapter'; v: number; t?: number }
  | { k: 'menu' | 'popup'; v: 0 | 1; t?: number } | { k: 'uo'; v: string /* hex of libbluray compressed mask */; t?: number } | { k: 'sound'; v: number; t?: number } | { k: 'still'; v: 0 | 1; t?: number }
  | { k: 'step'; n: number; plane?: string /* IG plane hash, Task 13 */ } | { k: 'end'; why: 'eof' | 'error' | 'limit' };

export function parseTrace(text: string): TraceEntry[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as TraceEntry;
      } catch {
        throw new Error(`trace line ${i + 1} is not JSON: ${line}`);
      }
    });
}

export function formatTrace(entries: readonly TraceEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}
