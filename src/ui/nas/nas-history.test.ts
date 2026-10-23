import { describe, expect, it, vi } from 'vitest';
import { NasHistory, type HistoryLike } from './nas-history';

class FakeWindow {
  entries: { state: unknown; url: string }[];
  index = 0;
  listeners = new Set<() => void>();
  constructor(url = '/') {
    this.entries = [{ state: null, url }];
  }
  get location(): { href: string } {
    return { href: new URL(this.entries[this.index]!.url, 'https://player.example').href };
  }
  history = {
    pushState: (s: unknown, _u: '', url: string): void => {
      this.entries.splice(this.index + 1);
      this.entries.push({ state: s, url });
      this.index++;
    },
    replaceState: (s: unknown, _u: '', url: string): void => {
      this.entries[this.index] = { state: s, url };
    },
    back: (): void => {
      this.index--;
      for (const l of [...this.listeners]) l();
    },
  };
  get state(): unknown {
    return this.entries[this.index]!.state;
  }
  addEventListener(_t: 'popstate', l: () => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'popstate', l: () => void): void {
    this.listeners.delete(l);
  }
}

function make(url = '/'): { win: FakeWindow; h: NasHistory } {
  const win = new FakeWindow(url);
  const like: HistoryLike = {
    get location() {
      return win.location;
    },
    history: {
      get state() {
        return win.state;
      },
      pushState: win.history.pushState,
      replaceState: win.history.replaceState,
      back: win.history.back,
    },
    addEventListener: (t, l) => win.addEventListener(t, l),
    removeEventListener: (t, l) => win.removeEventListener(t, l),
  };
  return { win, h: new NasHistory(like) };
}

describe('NasHistory', () => {
  it('parses the route and starts at depth 0 with a load move', () => {
    const { h } = make('/nas/title/anilist%3A21');
    expect(h.route()).toEqual({ kind: 'title', titleId: 'anilist:21' });
    expect(h.depth()).toBe(0);
    expect(h.lastMove()).toBe('load');
  });

  it('push adds an entry, increments depth and notifies', () => {
    const { win, h } = make();
    const l = vi.fn();
    h.subscribe(l);
    h.push({ kind: 'unsorted' });
    expect(win.entries).toHaveLength(2);
    expect(h.depth()).toBe(1);
    expect(h.route()).toEqual({ kind: 'unsorted' });
    expect(h.lastMove()).toBe('push');
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('replace keeps depth and other state keys', () => {
    const { win, h } = make();
    h.push({ kind: 'unsorted' });
    win.entries[win.index]!.state = { nasDepth: 1, other: 'x' };
    h.replace({ kind: 'hidden' });
    expect(win.entries).toHaveLength(2);
    expect(win.state).toEqual({ nasDepth: 1, other: 'x' });
    expect(h.lastMove()).toBe('replace');
  });

  it('push preserves other state keys', () => {
    const { win, h } = make();
    win.entries[0]!.state = { other: 'x' };
    h.push({ kind: 'hidden' });
    expect(win.state).toEqual({ other: 'x', nasDepth: 1 });
  });

  it('a push or replace to the current URL does nothing', () => {
    const { win, h } = make('/nas/unsorted');
    const l = vi.fn();
    h.subscribe(l);
    h.push({ kind: 'unsorted' });
    h.replace({ kind: 'unsorted' });
    expect(win.entries).toHaveLength(1);
    expect(l).not.toHaveBeenCalled();
    expect(h.lastMove()).toBe('load');
  });

  it('push(null) goes to /', () => {
    const { win, h } = make('/nas/hidden');
    h.push(null);
    expect(win.entries[1]!.url).toBe('/');
    expect(h.route()).toBeNull();
  });

  it('popstate notifies and sets the move to pop', () => {
    const { win, h } = make();
    h.push({ kind: 'unsorted' });
    const l = vi.fn();
    h.subscribe(l);
    win.history.back();
    expect(l).toHaveBeenCalledTimes(1);
    expect(h.lastMove()).toBe('pop');
    expect(h.depth()).toBe(0);
  });

  it('unsubscribe stops notifications and drops the popstate listener', () => {
    const { win, h } = make();
    const l = vi.fn();
    const off = h.subscribe(l);
    off();
    h.push({ kind: 'hidden' });
    expect(l).not.toHaveBeenCalled();
    expect(win.listeners.size).toBe(0);
  });

  it('back at depth 0 replaces with the fallback', () => {
    const { win, h } = make('/nas/hidden');
    h.back({ kind: 'unsorted' });
    expect(win.entries).toHaveLength(1);
    expect(h.route()).toEqual({ kind: 'unsorted' });
    expect(h.lastMove()).toBe('replace');
  });

  it('back at depth 1 calls history.back()', () => {
    const { win, h } = make();
    h.push({ kind: 'unsorted' });
    h.back({ kind: 'hidden' });
    expect(win.index).toBe(0);
    expect(h.route()).toBeNull();
  });

  it('getSnapshot is the href', () => {
    const { h } = make('/nas/hidden');
    expect(h.getSnapshot()).toBe('https://player.example/nas/hidden');
  });

  it('drops a write the browser refuses, warns once and does not notify', () => {
    const win = new FakeWindow('/');
    const like: HistoryLike = {
      get location() {
        return win.location;
      },
      history: {
        state: null,
        pushState: () => {
          throw new Error('SecurityError');
        },
        replaceState: () => {
          throw new Error('SecurityError');
        },
        back: () => {},
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const hh = new NasHistory(like);
    const l = vi.fn();
    hh.subscribe(l);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => hh.replace({ kind: 'library', shelf: null, q: 'a' })).not.toThrow();
    expect(() => hh.push({ kind: 'library', shelf: null, q: 'b' })).not.toThrow();
    expect(l).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('pushes a help path, with its hash, and the route outside /nas is null', () => {
    const { win, h } = make('/');
    const seen = vi.fn();
    h.subscribe(seen);
    h.pushPath('/help/nas#pairing');
    expect(win.entries.map((e) => e.url)).toEqual(['/', '/help/nas#pairing']);
    expect(h.depth()).toBe(1);
    expect(h.route()).toBeNull();
    expect(seen).toHaveBeenCalledTimes(1);
    h.pushPath('/help/nas#pairing');
    expect(win.entries).toHaveLength(2);
    h.pushPath('/help/nas');
    expect(win.entries).toHaveLength(3);
  });
});
