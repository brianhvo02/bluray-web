import { describe, expect, it } from 'vitest';
import { LOOP_GAP_MS, loopGap, type LoopClock } from './replay-player';
import { replaySettled } from './settled';

const DISC = new URL('../../fixtures/synthetic/disc-bdj-menu', import.meta.url);
const SCRIPT = 'arrows';

const replay = (loopClock: LoopClock) =>
  replaySettled(DISC, new URL(`./golden/disc-bdj-menu.${SCRIPT}.jsonl`, import.meta.url), new URL(`./scripts/disc-bdj-menu.${SCRIPT}.keys`, import.meta.url), {
    loopClock,
  });

/**
 * A loop clock on injected time: each read is one turn of the replay loop, `gapAt(turn)` long after the previous one,
 * with no CPU used. Real time and the machine's load play no part in what the loop-gap check sees.
 */
function turnClock(gapAt: (turn: number) => number): LoopClock & { readonly turns: () => number } {
  let turns = 0;
  let now = 0;
  return {
    nowMs: () => {
      if (turns > 0) now += gapAt(turns);
      turns++;
      return now;
    },
    cpuMs: () => 0,
    turns: () => turns,
  };
}

describe('a replay the host did not run (Task 7e: system sleep mid-run)', () => {
  it('names a gap with almost no CPU as a suspended host, and a busy one as a blocked event loop', () => {
    expect(loopGap(5, 5)).toBeNull();
    expect(loopGap(LOOP_GAP_MS - 1, 10)).toBeNull();
    expect(loopGap(970_000, 40)).toMatch(/^the process did not run for 970 s \(0\.04 s of CPU\): the host slept or was starved; the run is void$/);
    expect(loopGap(30_000, 29_000)).toMatch(/^the event loop was blocked for 30 s \(29\.0 s of CPU\)/);
  });

  it('a 1,000 s gap at the 20th turn fails the run there, as void, not as a step or run timeout', async () => {
    const clock = turnClock((turn) => (turn === 20 ? 1_000_000 : 1));
    await expect(replay(clock)).rejects.toThrow(/the process did not run for 1000 s \(0\.00 s of CPU\): the host slept or was starved; the run is void/);
    expect(clock.turns()).toBe(21); // the first read, then one per turn up to the 20th
  }, 180_000);

  it('gaps just under LOOP_GAP_MS on every turn leave the run alone', async () => {
    const clock = turnClock(() => LOOP_GAP_MS - 1);
    const { run } = await replay(clock);
    expect(run.trace.filter((e) => e.call === 'selectPlaylistN').map((e) => e.args[0])).toEqual([1, -1, 0]);
    expect(clock.turns()).toBeGreaterThan(20);
  }, 180_000);
});
