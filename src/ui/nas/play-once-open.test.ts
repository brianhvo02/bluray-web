import { describe, expect, it } from 'vitest';
import { EPISODE_MISSING_NOTICE, playOnceOpen, type OpeningController } from './play-once-open';

/** A controller stand-in: a snapshot, its listeners, and what the pre-flight asked of it. */
interface FakeController extends OpeningController {
  snapshot: { playlists: { id: string }[]; engineState: string; error: unknown };
  discOpens: number;
  readonly played: string[];
  readonly notices: { code: string; message: string }[];
  readonly listeners: Set<() => void>;
  set(next: Partial<FakeController['snapshot']>): void;
}

function fakeController(): FakeController {
  const listeners = new Set<() => void>();
  const c: FakeController = {
    snapshot: { playlists: [] as { id: string }[], engineState: 'loading', error: null as unknown },
    discOpens: 1,
    played: [] as string[],
    notices: [] as { code: string; message: string }[],
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot: () => c.snapshot,
    playPlaylist: (id: string) => {
      c.played.push(id);
    },
    showNotice: (code: string, message: string) => {
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

describe('playOnceOpen', () => {
  it("plays the episode's playlist once the disc's playlists arrive, then lets go", () => {
    const c = fakeController();
    playOnceOpen(c, '00001');
    c.set({ engineState: 'loading' });
    expect(c.played).toEqual([]);
    c.set({ playlists: [{ id: '00000' }, { id: '00001' }] });
    expect(c.played).toEqual(['00001']);
    expect(c.listeners.size).toBe(0);
  });

  it("leaves a disc without the episode's playlist as it opened, and says so", () => {
    const c = fakeController();
    playOnceOpen(c, '00009');
    c.set({ playlists: [{ id: '00000' }] });
    expect(c.played).toEqual([]);
    expect(c.notices).toEqual([{ code: 'episode-missing', message: EPISODE_MISSING_NOTICE }]);
    expect(EPISODE_MISSING_NOTICE).toBe("This episode isn't on this disc; it opened normally.");
    expect(c.listeners.size).toBe(0);
  });

  it('lets go when the open fails', () => {
    const c = fakeController();
    playOnceOpen(c, '00001');
    c.set({ error: { code: 'disc-changed' } });
    c.set({ error: null, playlists: [{ id: '00001' }] });
    expect(c.played).toEqual([]);
    expect(c.listeners.size).toBe(0);
  });

  it('never fires for another disc: a new open or a close lets go', () => {
    const c = fakeController();
    playOnceOpen(c, '00001');
    c.discOpens++; // another disc opened, or this one closed
    c.set({ playlists: [] });
    c.set({ playlists: [{ id: '00001' }] });
    expect(c.played).toEqual([]);
    expect(c.listeners.size).toBe(0);
  });

  it('can be released by its owner (the pre-flight unmounting)', () => {
    const c = fakeController();
    const release = playOnceOpen(c, '00001');
    release();
    c.set({ playlists: [{ id: '00001' }] });
    expect(c.played).toEqual([]);
    expect(c.listeners.size).toBe(0);
  });
});
