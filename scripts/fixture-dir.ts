import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = resolve(fileURLToPath(new URL('../fixtures', import.meta.url)));

/** Resolves a fixture output folder, refusing anything outside the repo's fixtures/ (it gets deleted and rewritten). */
export function fixtureDir(outDir: string): string {
  const abs = resolve(outDir);
  const rel = relative(FIXTURES, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write fixtures to ${abs}: the folder must be inside ${FIXTURES}`);
  }
  return abs;
}

/** Replaces `outDir` (inside fixtures/) with `files`, skipping paths for which `skip` returns true. */
export function writeFixture(outDir: string, files: ReadonlyMap<string, Uint8Array>, skip: (path: string) => boolean = () => false): void {
  const dir = fixtureDir(outDir);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, bytes] of files) {
    if (skip(path)) continue;
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}
