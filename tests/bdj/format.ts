import type { TraceEntry } from '../../src/engine/bdj/host';

export type { TraceEntry };

export const CONTROL_CALLS: ReadonlySet<string> = new Set([
  'selectTitleN', 'selectPlaylistN', 'seekN', 'selectAngleN', 'selectRateN',
  'writeRegN', 'setUOMaskN', 'setKeyInterestN', 'soundEffectN', 'setVirtualPackageN',
]);

/** Reads harness output, skipping every line that is not a JSON object with a `call` field (JVM and libbluray logging). */
export function parseBdjTrace(text: string): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof v === 'object' && v !== null && typeof (v as { call?: unknown }).call === 'string') out.push(v as TraceEntry);
  }
  return out;
}
