import { describe, expect, it } from 'vitest';
import { EPISODE_MISSING_NOTICE, noticeMissingStart, type StartingController } from './missing-start-notice';

interface Fake extends StartingController {
  snapshot: { startFailed: 'no-playlist' | 'past-end' | null; engineState: string; error: unknown };
  discOpens: number;
  readonly menuCalls: number[];
  readonly notices: { code: string; message: string }[];
  readonly listeners: Set<() => void>;
  set(next: Partial<Fake['snapshot']>): void;
}

function fake(): Fake {
  const listeners = new Set<() => void>();
  const c: Fake = {
    snapshot: { startFailed: null, engineState: 'loading', error: null },
    discOpens: 1,
    menuCalls: [],
    notices: [],
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => c.snapshot,
    menuCall: () => {
      c.menuCalls.push(1);
    },
    showNotice: (code, message) => {
      c.notices.push({ code, message });
    },
    listeners,
    set(next) {
      c.snapshot = { ...c.snapshot, ...next };
      for (const l of [...listeners]) l();
    },
  };
  return c;
}

describe('noticeMissingStart', () => {
  it('says so and opens the top menu when the playlist is missing, then lets go', () => {
    const c = fake();
    noticeMissingStart(c);
    c.set({ engineState: 'idle' });
    expect(c.notices).toEqual([]);
    c.set({ startFailed: 'no-playlist' });
    expect(c.notices).toEqual([{ code: 'episode-missing', message: EPISODE_MISSING_NOTICE }]);
    expect(EPISODE_MISSING_NOTICE).toBe("This episode isn't on this disc; it opened normally.");
    expect(c.menuCalls).toHaveLength(1);
    expect(c.listeners.size).toBe(0);
  });

  it('does nothing for a time past the end, and lets go', () => {
    const c = fake();
    noticeMissingStart(c);
    c.set({ startFailed: 'past-end' });
    expect(c.notices).toEqual([]);
    expect(c.menuCalls).toEqual([]);
    expect(c.listeners.size).toBe(0);
  });

  it('lets go when the open fails, or another disc opens or this one closes', () => {
    const failed = fake();
    noticeMissingStart(failed);
    failed.set({ error: { code: 'disc-changed' } });
    failed.set({ error: null, startFailed: 'no-playlist' });
    expect(failed.notices).toEqual([]);
    expect(failed.listeners.size).toBe(0);

    const other = fake();
    noticeMissingStart(other);
    other.discOpens = 2;
    other.set({ startFailed: 'no-playlist' });
    expect(other.notices).toEqual([]);
    expect(other.menuCalls).toEqual([]);
    expect(other.listeners.size).toBe(0);
  });

  it('is released by the returned function', () => {
    const c = fake();
    noticeMissingStart(c)();
    expect(c.listeners.size).toBe(0);
  });
});
