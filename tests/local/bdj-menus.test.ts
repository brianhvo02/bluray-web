import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replaySettled } from '../bdj/settled';

/**
 * The developer's BD-J discs from their first menu to the feature, through the real Player, against libbluray's runs of
 * the same key scripts (tests/bdj/scripts/<disc>.<script>.keys; goldens in tests/bdj/golden/local/, written by
 * tools/bdj-trace/golden.sh when the disc is present, control calls and settled plane hashes only). Each disc's tests
 * skip when it is absent; no Docker is needed.
 */
const LOCAL = (name: string): string => fileURLToPath(new URL(`../../fixtures/local/${name}`, import.meta.url));
const golden = (name: string): URL => new URL(`../bdj/golden/local/${name}.jsonl`, import.meta.url);
const script = (name: string): URL => new URL(`../bdj/scripts/${name}.keys`, import.meta.url);

interface Case {
  readonly disc: string;
  readonly script: string;
  /** The feature playlist the script ends on. */
  readonly feature: number;
  readonly what: string;
}

const CASES: readonly Case[] = [
  { disc: 'A_NEW_ERA', script: 'a_new_era.play', feature: 40, what: 'main menu, PLAY, the feature' },
  { disc: 'A_NEW_ERA', script: 'a_new_era.chapters', feature: 40, what: 'main menu, CHAPTERS, chapter 2, the feature' },
  { disc: 'RENTAL_FAMILY', script: 'rental_family.play', feature: 800, what: 'language picker, English, main menu, PLAY, the feature' },
];

for (const c of CASES) {
  const dir = LOCAL(c.disc);
  describe.skipIf(!existsSync(dir) || !existsSync(golden(c.script)))(`${c.disc} against libbluray`, () => {
    it(`${c.what}: the same control calls and settled planes`, async () => {
      // the first step counts from the open, as the harness's --wait-timeout 60 does from its start
      const { run, golden: g } = await replaySettled(dir, golden(c.script), script(c.script), { timeoutMs: 280_000, stepTimeoutMs: 90_000 });
      const playlists = run.trace.filter((e) => e.call === 'selectPlaylistN' && e.args[0] !== -1).map((e) => e.args[0]);
      expect(playlists.at(-1)).toBe(c.feature);
      const settled = g.steps.flatMap((s) => (s.hash ? [s.hash] : []));
      console.log(`${c.script}: settled ${settled.join(' ')}, end ${g.endHash}; ours ${run.flushes.length} flushes, ${run.untilMs.toFixed(0)} ms`);
    }, 300_000);
  });
}
