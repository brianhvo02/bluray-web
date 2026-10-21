import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopGap } from './replay-player';
import { replaySettled } from './settled';

const DISC = new URL('../../fixtures/synthetic/disc-bdj-menu', import.meta.url);
const SCRIPT = 'arrows';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a replay the host did not run (Task 7e: system sleep mid-run)', () => {
  it('names a gap with almost no CPU as a suspended host, and a busy one as a blocked event loop', () => {
    expect(loopGap(5, 5)).toBeNull();
    expect(loopGap(19_000, 10)).toBeNull();
    expect(loopGap(970_000, 40)).toMatch(/^the process did not run for 970 s \(0\.04 s of CPU\): the host slept or was starved; the run is void$/);
    expect(loopGap(30_000, 29_000)).toMatch(/^the event loop was blocked for 30 s \(29\.0 s of CPU\)/);
  });

  it('fails at once with the suspension, not with a step or run timeout, when the clock jumps 1,000 s', async () => {
    const now = performance.now.bind(performance);
    let offset = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now() + offset);
    // the clock jumps as Node's does across a macOS sleep (it counts the time asleep); real timers fire as before
    setTimeout(() => (offset = 1_000_000), 1500);
    const t0 = now();
    const run = replaySettled(DISC, new URL(`./golden/disc-bdj-menu.${SCRIPT}.jsonl`, import.meta.url), new URL(`./scripts/disc-bdj-menu.${SCRIPT}.keys`, import.meta.url));
    await expect(run).rejects.toThrow(/the process did not run for 1000 s .*the host slept or was starved; the run is void/);
    expect(now() - t0).toBeLessThan(30_000);
  }, 60_000);
});
