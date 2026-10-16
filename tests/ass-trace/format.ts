/**
 * The libass layout trace (tools/ass-trace/trace.patch): one JSON line per event shown at a time, in libass's output
 * order (layer, then input order). Values are libass's own: GlyphInfo fields in its units (sizes in script units,
 * rotations in degrees), positions in frame pixels.
 */

export interface TraceGlyph { readonly x: number; readonly y: number; readonly adv: number; readonly ch: number }

export interface TraceRun {
  readonly text: string;
  /** "<requested family>|<PostScript name of the face drawn>". */
  readonly font: string;
  readonly size: number;
  readonly scale: readonly [number, number];
  readonly hspacing: number;
  /** c[0..3] as RRGGBBAA hex, fade applied. */
  readonly colors: readonly [string, string, string, string];
  readonly border: readonly [number, number];
  readonly shadow: readonly [number, number];
  readonly blur: number;
  readonly be: number;
  readonly rot: readonly [number, number, number];
  readonly shear: readonly [number, number];
  readonly borderStyle: number;
  readonly flags: number;
  readonly bold: number;
  readonly italic: number;
  /** effect_type and effect_timing of the run's combined bitmap (after ass_process_karaoke_effects). */
  readonly karaoke: readonly [number, number];
  readonly drawing: boolean;
  /** calc_transform_matrix's m for the run's first glyph, row-major, divided by m[2][2]. */
  readonly matrix: readonly number[];
  readonly glyphs: readonly TraceGlyph[];
}

export type TraceClip =
  | { readonly rect: readonly [number, number, number, number]; readonly inverse: boolean }
  | { readonly vector: string; readonly scale: number; readonly inverse: boolean };

export interface TraceEvent {
  readonly t: number;
  /** Index in the track's events (file order). */
  readonly event: number;
  readonly layer: number;
  /** EventImages left, top, width, height after fix_collisions. */
  readonly box: readonly [number, number, number, number];
  readonly lines: number;
  readonly clip: TraceClip;
  readonly runs: readonly TraceRun[];
}

export function parseTrace(jsonl: string): TraceEvent[] {
  return jsonl.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as TraceEvent);
}

/** As the harness prints doubles (%.6f). */
const round = (v: number): number => {
  const r = Number(v.toFixed(6));
  return Object.is(r, -0) ? 0 : r;
};

const num = (v: number): number => round(v);
const nums = <T extends readonly number[]>(v: T): T => v.map(num) as unknown as T;

function clip(c: TraceClip): TraceClip {
  return 'rect' in c ? { rect: nums(c.rect), inverse: c.inverse } : { vector: c.vector, scale: c.scale, inverse: c.inverse };
}

function run(r: TraceRun): TraceRun {
  return {
    text: r.text, font: r.font, size: num(r.size), scale: nums(r.scale), hspacing: num(r.hspacing), colors: r.colors,
    border: nums(r.border), shadow: nums(r.shadow), blur: num(r.blur), be: r.be, rot: nums(r.rot), shear: nums(r.shear),
    borderStyle: r.borderStyle, flags: r.flags, bold: r.bold, italic: r.italic, karaoke: r.karaoke, drawing: r.drawing,
    // a projective matrix needs more than 1/64: keep 6 significant digits
    matrix: r.matrix.map((v) => { const p = Number(v.toPrecision(6)); return Object.is(p, -0) ? 0 : p; }),
    glyphs: r.glyphs.map((g) => ({ x: num(g.x), y: num(g.y), adv: num(g.adv), ch: g.ch })),
  };
}

/** One line per event, keys in the order of TraceEvent, numbers rounded to 6 decimals; ends with a newline. */
export function formatTrace(events: readonly TraceEvent[]): string {
  return events.map((e) => JSON.stringify({ t: e.t, event: e.event, layer: e.layer, box: nums(e.box), lines: e.lines, clip: clip(e.clip), runs: e.runs.map(run) }) + '\n').join('');
}
