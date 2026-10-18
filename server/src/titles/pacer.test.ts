import { describe, expect, it } from 'vitest';
import { Pacer, RateLimited } from './pacer';
import { SourceUnavailable } from './sources';

/** Lets every queued promise settle (the sleeps are fake, so nothing else is pending). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Pacer', () => {
  it('runs 30 calls in a minute, then waits for the window to pass', async () => {
    let t = 0;
    const sleeps: { ms: number; wake: () => void }[] = [];
    const sleep = (ms: number): Promise<void> => new Promise((wake) => sleeps.push({ ms, wake }));
    const pacer = new Pacer(30, 60_000, () => t, sleep);
    const started: number[] = [];
    const runs = Array.from({ length: 31 }, (_, i) => pacer.run(async () => (started.push(t), i)));
    await flush();
    expect(started).toHaveLength(30);
    expect(sleeps.map((s) => s.ms)).toEqual([60_000]);
    t = 60_000;
    sleeps[0]!.wake();
    expect(await Promise.all(runs)).toEqual(Array.from({ length: 31 }, (_, i) => i));
    expect(started[30]).toBe(60_000);
  });

  it('spaces calls by the oldest one in the window', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const pacer = new Pacer(2, 1_000, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    await pacer.run(async () => null);
    t = 400;
    await pacer.run(async () => null);
    await pacer.run(async () => null); // waits until the first leaves the window at 1000
    expect(sleeps).toEqual([600]);
    expect(t).toBe(1_000);
  });

  it('waits Retry-After once on a 429, then throws SourceUnavailable', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const pacer = new Pacer(30, 60_000, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    let calls = 0;
    const run = pacer.run(async () => {
      calls++;
      throw new RateLimited(2_000);
    });
    await expect(run).rejects.toBeInstanceOf(SourceUnavailable);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2_000]);
  });

  it('answers after a 429 when the retry succeeds', async () => {
    let t = 0;
    const pacer = new Pacer(30, 60_000, () => t, async (ms) => {
      t += ms;
    });
    let calls = 0;
    const value = await pacer.run(async () => {
      if (calls++ === 0) throw new RateLimited(null);
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(t).toBe(60_000); // no Retry-After: one window
  });

  it('passes other errors through', async () => {
    const pacer = new Pacer(1, 1_000);
    await expect(pacer.run(async () => Promise.reject(new SourceUnavailable('down')))).rejects.toThrow('down');
  });
});
