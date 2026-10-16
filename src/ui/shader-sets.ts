import hqConf from './anime4k/input-hq.conf?raw';
import fastConf from './anime4k/input-fast.conf?raw';

export interface ShaderSetDef {
  readonly name: string;
  readonly files: readonly string[];
  readonly origin: 'anime4k' | 'imported';
}

export interface SetEntry extends ShaderSetDef {
  readonly missing: readonly string[];
  readonly available: boolean;
}

const SET_RE = /glsl-shaders\s+set\s+"([^"]*)"/;
const SHOW_TEXT_RE = /show-text\s+"([^"]*)"/;

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** Reads the `glsl-shaders set` lines of an mpv input.conf (`:` or `;` separated lists). */
export function parseInputConf(text: string): ShaderSetDef[] {
  const sets: ShaderSetDef[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = SET_RE.exec(line);
    if (!m) continue;
    const files = m[1]!
      .split(/[:;]/)
      .map((f) => baseName(f.trim()))
      .filter((f) => f !== '');
    if (files.length === 0) continue;
    const name = SHOW_TEXT_RE.exec(line)?.[1] ?? line.split(/\s+/)[0]!;
    sets.push({ name, files, origin: 'imported' });
  }
  return sets;
}

export const BUILT_IN_SETS: readonly ShaderSetDef[] = [
  ...parseInputConf(hqConf),
  ...parseInputConf(fastConf),
].map((s) => ({ ...s, origin: 'anime4k' as const }));

function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

function entry(def: ShaderSetDef, library: ReadonlySet<string>): SetEntry {
  const missing = def.files.filter((f) => !library.has(f));
  return { ...def, missing, available: missing.length === 0 };
}

/** Built-ins appear once any of their files is in the library; imported sets always, unless equal to a built-in's list. */
export function resolveSets(imported: readonly ShaderSetDef[], library: ReadonlySet<string>): SetEntry[] {
  const out: SetEntry[] = [];
  for (const def of BUILT_IN_SETS) {
    if (def.files.some((f) => library.has(f))) out.push(entry(def, library));
  }
  for (const def of imported) {
    if (BUILT_IN_SETS.some((b) => sameFiles(b.files, def.files))) continue;
    out.push(entry(def, library));
  }
  return out;
}

export function missingLabel(missing: readonly string[]): string {
  const more = missing.length - 1;
  return `missing: ${missing[0]}${more > 0 ? ` +${more} more` : ''}`;
}
