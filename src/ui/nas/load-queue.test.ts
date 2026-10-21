import { describe, expect, it } from 'vitest';
import { LoadQueue, type LoadPriority } from './load-queue';

/** A load that ends when told to, recording when it started. */
function loads(): { make: (name: string) => () => Promise<void>; started: string[]; end: (name: string) => Promise<void> } {
  const started: string[] = [];
  const enders = new Map<string, () => void>();
  return {
    started,
    make: (name) => () => {
      started.push(name);
      return new Promise<void>((resolve) => enders.set(name, resolve));
    },
    end: async (name) => {
      enders.get(name)!();
      // the queue picks the next load a microtask after one ends
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('LoadQueue', () => {
  it('runs at most `limit` loads at once, starting the next as one ends', async () => {
    const l = loads();
    const q = new LoadQueue(2);
    for (const n of ['a', 'b', 'c']) q.add(l.make(n), 2);
    expect(l.started).toEqual(['a', 'b']);
    await l.end('a');
    expect(l.started).toEqual(['a', 'b', 'c']);
    expect(q.active).toBe(2);
  });

  it('starts on-screen loads before those in scroll range, and those before the rest, in order within each', async () => {
    const l = loads();
    const q = new LoadQueue(1);
    q.add(l.make('first'), 2);
    const add = (n: string, p: LoadPriority) => q.add(l.make(n), p);
    add('far1', 2);
    add('near1', 1);
    add('far2', 2);
    add('seen', 0);
    add('near2', 1);
    for (const n of ['first', 'seen', 'near1', 'near2', 'far1']) await l.end(n);
    expect(l.started).toEqual(['first', 'seen', 'near1', 'near2', 'far1', 'far2']);
  });

  it('follows a priority changed while waiting (a poster scrolled into view)', async () => {
    const l = loads();
    const q = new LoadQueue(1);
    q.add(l.make('first'), 0);
    q.add(l.make('a'), 2);
    const b = q.add(l.make('b'), 2);
    b.setPriority(0);
    await l.end('first');
    expect(l.started).toEqual(['first', 'b']);
  });

  it('drops a cancelled waiting load, and gives a cancelled running load’s slot to the next', async () => {
    const l = loads();
    const q = new LoadQueue(1);
    const running = q.add(l.make('running'), 0);
    q.add(l.make('dropped'), 1).cancel();
    q.add(l.make('next'), 2);
    running.cancel();
    await Promise.resolve();
    expect(l.started).toEqual(['running', 'next']);
    // the cancelled load ending later frees nothing twice
    await l.end('running');
    expect(q.active).toBe(1);
  });

  it('holds loads above the ceiling until they are wanted or the ceiling rises', async () => {
    const l = loads();
    const q = new LoadQueue(2);
    q.setCeiling(1);
    q.add(l.make('far'), 2);
    const later = q.add(l.make('scrolled-to'), 2);
    expect(l.started).toEqual([]);
    later.setPriority(1);
    expect(l.started).toEqual(['scrolled-to']);
    q.setCeiling(2);
    expect(l.started).toEqual(['scrolled-to', 'far']);
  });

  it('frees the slot of a load that fails', async () => {
    const q = new LoadQueue(1);
    const started: string[] = [];
    q.add(() => {
      started.push('bad');
      return Promise.reject(new Error('gone'));
    }, 0);
    q.add(async () => void started.push('good'), 0);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(started).toEqual(['bad', 'good']);
  });
});
