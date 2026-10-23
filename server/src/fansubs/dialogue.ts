/** The spans of an ASS script that are spoken dialogue, not signs, songs or typesetting. Pure; original code. */
import { parseAss } from '../../../src/engine/ass/parse';

const NON_DIALOGUE_STYLE = /sign|song|op|ed|kara|title|insert|note/i;
const POSITIONED = /\\(?:pos|move)\s*\(/;
const KARAOKE = /\\k[fo]?\d/;
const MIN_MS = 300;
const MAX_MS = 10_000;

/** Dialogue events' spans, sorted and merged where they overlap. Commented lines are not events. */
export function dialogueIntervals(ass: string): { fromMs: number; toMs: number }[] {
  const track = parseAss(ass);
  const spans: { fromMs: number; toMs: number }[] = [];
  for (const e of track.events) {
    if (e.duration < MIN_MS || e.duration > MAX_MS) continue;
    if (NON_DIALOGUE_STYLE.test(track.styles[e.style]?.name ?? '')) continue;
    if (POSITIONED.test(e.text) || KARAOKE.test(e.text)) continue;
    spans.push({ fromMs: e.start, toMs: e.start + e.duration });
  }
  spans.sort((a, b) => a.fromMs - b.fromMs);
  const merged: { fromMs: number; toMs: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, s.toMs);
    else merged.push({ ...s });
  }
  return merged;
}
