import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replayBdj } from '../bdj/replay';

const LOCAL = fileURLToPath(new URL('../../fixtures/local', import.meta.url)); // independent of the working directory

/** The first playlist each known disc's BD-J menu selects, from libbluray's trace (npm run bdj-trace). */
const FIRST_PLAYLIST: Readonly<Record<string, number>> = { A_NEW_ERA: 833, RENTAL_FAMILY: 1611 };

function bdjDiscs(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .map((name) => join(LOCAL, name))
    .filter((dir) => existsSync(join(dir, 'BDMV', 'BDJO')));
}

const discs = bdjDiscs();

describe.skipIf(discs.length === 0)('local BD-J discs', () => {
  for (const dir of discs) {
    const name = basename(dir);
    it(`${name} boots to its first playlist`, async () => {
      const { trace, bootMs, untilMs } = await replayBdj(dir, { until: 'selectPlaylistN', timeoutMs: 120_000 });
      console.log(`${name}: bootMs ${bootMs.toFixed(0)}, untilMs ${untilMs.toFixed(0)}`);
      const last = trace.at(-1)!;
      expect(last.call).toBe('selectPlaylistN');
      const expected = FIRST_PLAYLIST[name];
      if (expected !== undefined) expect(last.args[0]).toBe(expected);
    }, 150_000);
  }
});
