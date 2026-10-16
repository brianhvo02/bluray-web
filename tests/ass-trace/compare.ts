/** Compares our layout trace with libass's (tolerances: plan Task 2, Global Constraints). */
import type { TraceClip, TraceEvent, TraceRun } from './format';

export interface TraceDiff { readonly t: number; readonly event: number; readonly path: string; readonly expected: unknown; readonly actual: unknown }
export interface CompareOptions {
  /** Pixel tolerance for positions, sizes and boxes. */
  readonly tolerance: number;
  /** Lower-case families missing from the fonts given: runs requesting them are compared on that family only. */
  readonly missingFamilies: ReadonlySet<string>;
}

const ANGLE = 1e-5; // %.6f in C rounds halves to even, toFixed does not
const MATRIX = 1e-4;
const MATRIX_PERSPECTIVE = 2e-3;

type Push = (path: string, expected: unknown, actual: unknown) => void;

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
const nearRel = (a: number, b: number, rel: number): boolean => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

function nums(push: Push, path: string, e: readonly number[], a: readonly number[], ok: (x: number, y: number) => boolean): void {
  e.forEach((v, i) => { if (!ok(v, a[i]!)) push(`${path}[${i}]`, v, a[i]); });
}

function clip(push: Push, e: TraceClip, a: TraceClip, tol: number): void {
  if (e.inverse !== a.inverse) push('clip.inverse', e.inverse, a.inverse);
  if ('rect' in e && 'rect' in a) nums(push, 'clip.rect', e.rect, a.rect, (x, y) => near(x, y, tol));
  else if ('vector' in e && 'vector' in a) {
    if (e.vector !== a.vector) push('clip.vector', e.vector, a.vector);
    if (e.scale !== a.scale) push('clip.scale', e.scale, a.scale);
  } else push('clip', e, a);
}

function run(push: Push, p: string, e: TraceRun, a: TraceRun, opts: CompareOptions): void {
  const family = (font: string): string => font.split('|')[0]!;
  const missing = opts.missingFamilies.has(family(e.font).toLowerCase());
  if (missing ? family(e.font) !== family(a.font) : e.font !== a.font) push(`${p}.font`, e.font, a.font);
  const exact = ['text', 'borderStyle', 'flags', 'bold', 'italic', 'drawing', 'be'] as const;
  for (const k of exact) if (e[k] !== a[k]) push(`${p}.${k}`, e[k], a[k]);
  e.colors.forEach((c, i) => { if (c !== a.colors[i]) push(`${p}.colors[${i}]`, c, a.colors[i]); });
  if (e.karaoke[0] !== a.karaoke[0]) push(`${p}.karaoke[0]`, e.karaoke[0], a.karaoke[0]);
  if (e.glyphs.length !== a.glyphs.length) push(`${p}.glyphs.length`, e.glyphs.length, a.glyphs.length);
  else e.glyphs.forEach((g, i) => { if (g.ch !== a.glyphs[i]!.ch) push(`${p}.glyphs[${i}].ch`, g.ch, a.glyphs[i]!.ch); });
  nums(push, `${p}.rot`, e.rot, a.rot, (x, y) => near(x, y, ANGLE));
  nums(push, `${p}.shear`, e.shear, a.shear, (x, y) => near(x, y, ANGLE));
  if (missing) return; // a fallback face's metrics differ: geometry is meaningless
  const tol = opts.tolerance;
  for (const k of ['size', 'hspacing', 'blur'] as const) if (!near(e[k], a[k], tol)) push(`${p}.${k}`, e[k], a[k]);
  nums(push, `${p}.scale`, e.scale, a.scale, (x, y) => near(x, y, ANGLE));
  nums(push, `${p}.border`, e.border, a.border, (x, y) => near(x, y, tol));
  nums(push, `${p}.shadow`, e.shadow, a.shadow, (x, y) => near(x, y, tol));
  // \kf (type 2) is a pixel position; the other karaoke types are a 26.6 distance from the glyph
  const kTol = e.karaoke[0] === 2 ? tol : 64 * tol;
  if (!near(e.karaoke[1], a.karaoke[1], kTol)) push(`${p}.karaoke[1]`, e.karaoke[1], a.karaoke[1]);
  // the translation terms are the glyph position in 26.6: compare them like positions
  e.matrix.forEach((v, i) => {
    // perspective amplifies sub-pixel position differences into the other terms
    const rel = e.matrix[6] !== 0 || e.matrix[7] !== 0 ? MATRIX_PERSPECTIVE : MATRIX;
    const ok = i === 2 || i === 5 ? near(v, a.matrix[i]!, 64 * tol) : nearRel(v, a.matrix[i]!, rel);
    if (!ok) push(`${p}.matrix[${i}]`, v, a.matrix[i]);
  });
  if (e.glyphs.length === a.glyphs.length) {
    e.glyphs.forEach((g, i) => {
      const o = a.glyphs[i]!;
      for (const k of ['x', 'y', 'adv'] as const) if (!near(g[k], o[k], tol)) push(`${p}.glyphs[${i}].${k}`, g[k], o[k]);
    });
  }
}

function event(push: Push, e: TraceEvent, a: TraceEvent, opts: CompareOptions): void {
  if (e.layer !== a.layer) push('layer', e.layer, a.layer);
  if (e.lines !== a.lines) push('lines', e.lines, a.lines);
  const anyMissing = e.runs.some((r) => opts.missingFamilies.has(r.font.split('|')[0]!.toLowerCase()));
  // libass truncates the box to integers, so a sub-pixel difference can move it by one
  if (!anyMissing) nums(push, 'box', e.box, a.box, (x, y) => near(x, y, Math.max(1, opts.tolerance)));
  clip(push, e.clip, a.clip, opts.tolerance);
  if (e.runs.length !== a.runs.length) push('runs.length', e.runs.length, a.runs.length);
  else e.runs.forEach((r, i) => run(push, `runs[${i}]`, r, a.runs[i]!, opts));
}

export function compareTraces(expected: readonly TraceEvent[], actual: readonly TraceEvent[], opts: CompareOptions): TraceDiff[] {
  const diffs: TraceDiff[] = [];
  const key = (e: TraceEvent): string => `${e.t}:${e.event}`;
  const byKey = new Map(actual.map((e) => [key(e), e]));
  for (const e of expected) {
    const a = byKey.get(key(e));
    byKey.delete(key(e));
    if (!a) {
      diffs.push({ t: e.t, event: e.event, path: '', expected: e, actual: undefined });
      continue;
    }
    event((path, ex, ac) => diffs.push({ t: e.t, event: e.event, path, expected: ex, actual: ac }), e, a, opts);
  }
  for (const a of byKey.values()) diffs.push({ t: a.t, event: a.event, path: '', expected: undefined, actual: a });
  return diffs;
}

export function formatDiffs(diffs: readonly TraceDiff[], limit = 20): string {
  const shown = diffs.slice(0, limit).map((d) => {
    if (d.path === '') return `t=${d.t} event ${d.event}: ${d.actual === undefined ? 'missing' : 'unexpected'}`;
    return `t=${d.t} event ${d.event} ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`;
  });
  if (diffs.length > limit) shown.push(`… and ${diffs.length - limit} more`);
  return shown.join('\n');
}
