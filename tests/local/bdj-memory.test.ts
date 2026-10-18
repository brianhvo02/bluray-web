import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JvmMemoryStats } from '../../src/engine/bdj/jvm/jvm';
import { MEMORY_PROFILES } from '../../src/engine/memory-profile';
import { replaySettled } from '../bdj/settled';

/**
 * The developer's BD-J discs under the constrained memory profile (phones and tablets, 5d spec §4.5): the same runs as
 * bdj-menus.test.ts, which runs them under the desktop profile, with the same control calls and settled planes as
 * libbluray's, and the JVM's own accounting under the profile's budgets at the end. Each disc's tests skip when it is
 * absent.
 */
const LOCAL = (name: string): string => fileURLToPath(new URL(`../../fixtures/local/${name}`, import.meta.url));
const golden = (name: string): URL => new URL(`../bdj/golden/local/${name}.jsonl`, import.meta.url);
const script = (name: string): URL => new URL(`../bdj/scripts/${name}.keys`, import.meta.url);

const CASES: readonly { readonly disc: string; readonly script: string }[] = [
  { disc: 'A_NEW_ERA', script: 'a_new_era.play' },
  { disc: 'A_NEW_ERA', script: 'a_new_era.chapters' },
  { disc: 'RENTAL_FAMILY', script: 'rental_family.play' },
];

const budgets = MEMORY_PROFILES.constrained;
const mb = (n: number): string => (n / (1024 * 1024)).toFixed(2);

for (const c of CASES) {
  const dir = LOCAL(c.disc);
  describe.skipIf(!existsSync(dir) || !existsSync(golden(c.script)))(`${c.disc} under the constrained memory profile`, () => {
    it(`${c.script}: libbluray's control calls and settled planes, within the BD-J memory budgets`, async () => {
      let stats: JvmMemoryStats | null = null;
      await replaySettled(dir, golden(c.script), script(c.script), {
        timeoutMs: 280_000,
        stepTimeoutMs: 90_000,
        memoryProfile: 'constrained',
        beforeClose: (_player, worker) => {
          stats = worker?.runtime?.jvm.memoryStats() ?? null;
        },
      });
      const s = stats as JvmMemoryStats | null;
      expect(s).not.toBeNull();
      console.log(
        `${c.script} (constrained): ${s!.classes} classes keep ${mb(s!.classFileBytes)} MB, memory mounts ${mb(s!.vfsUsedBytes)} MB in ${s!.vfsFiles} files, ` +
          `${s!.zipHandles} zips open keeping ${mb(s!.zipBytes)} MB of their own`,
      );
      expect(s!.classFileBytes).toBeLessThanOrEqual(budgets.bdjClassCacheBytes);
      expect(s!.vfsUsedBytes).toBeLessThanOrEqual(budgets.bdjVfsCacheBytes);
      // ZipFile objects of one unchanged file share one archive, read from the Vfs's own copy where it has one
      expect(s!.zipBytes).toBe(0);
    }, 300_000);
  });
}
