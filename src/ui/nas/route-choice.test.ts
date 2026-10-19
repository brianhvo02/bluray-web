import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RtcLink } from './rtc/rtc-connection';
import { HEALTH_TIMEOUT_MS, chooseRoute, chooseWebRtc } from './route-choice';
import type { Route } from './route-choice';

const BASE = 'https://nas.example/bluray/api/';
const NAS_ID = 'n'.repeat(43);

afterEach(() => {
  vi.useRealTimers();
});

function fakeLink(): RtcLink & { fire(): void } {
  const listeners: Array<() => void> = [];
  return {
    fetch: (async () => new Response(null, { status: 204 })) as typeof fetch,
    relayed: false,
    closed: false,
    onClose: (cb) => listeners.push(cb),
    close() {},
    fire() {
      for (const cb of listeners) cb();
    },
  };
}

/** A fetch that answers `health` per `answer`, or hangs until aborted. */
function healthFetch(answer: 'ok' | 'hang' | 'refused'): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    if (answer === 'ok') return Response.json({ ok: true });
    if (answer === 'refused') throw new TypeError('Failed to fetch');
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

describe('chooseRoute', () => {
  it('takes HTTPS when its health check answers within 2 s', async () => {
    const fetch = healthFetch('ok');
    const connect = vi.fn(async () => fakeLink());
    expect(await chooseRoute({ base: BASE, nasId: NAS_ID }, { fetch, connect })).toEqual({ kind: 'https', base: BASE });
    expect(fetch.calls).toEqual([`${BASE}health`]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('takes WebRTC after 2 s when HTTPS hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(HEALTH_TIMEOUT_MS).toBe(2_000);
    const link = fakeLink();
    const connect = vi.fn(async () => link);
    let settled: Route | null = null;
    const choosing = chooseRoute({ base: BASE, nasId: NAS_ID }, { fetch: healthFetch('hang'), connect }).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await choosing;
    expect(settled).toEqual({ kind: 'webrtc', connection: link });
    expect(connect).toHaveBeenCalledWith(NAS_ID);
  });

  it('takes WebRTC when HTTPS fails', async () => {
    const link = fakeLink();
    expect(await chooseRoute({ base: BASE, nasId: NAS_ID }, { fetch: healthFetch('refused'), connect: async () => link })).toEqual({ kind: 'webrtc', connection: link });
  });

  it('takes WebRTC at once without an HTTPS base', async () => {
    const fetch = healthFetch('ok');
    const link = fakeLink();
    expect(await chooseRoute({ base: '', nasId: NAS_ID }, { fetch, connect: async () => link })).toEqual({ kind: 'webrtc', connection: link });
    expect(fetch.calls).toEqual([]);
  });

  it('keeps HTTPS without checking it for a NAS with no WebRTC id', async () => {
    const fetch = healthFetch('hang');
    expect(await chooseRoute({ base: BASE }, { fetch, connect: async () => fakeLink() })).toEqual({ kind: 'https', base: BASE });
    expect(fetch.calls).toEqual([]);
  });

  it('caches the choice per NAS, and chooses again once the connection closes', async () => {
    const cache = new Map<string, Promise<Route>>();
    const links = [fakeLink(), fakeLink()];
    const connect = vi.fn(async () => links[connect.mock.calls.length - 1]);
    const fetch = healthFetch('refused');
    const target = { base: BASE, nasId: NAS_ID };
    const [a, b] = await Promise.all([chooseRoute(target, { fetch, connect, cache }), chooseRoute(target, { fetch, connect, cache })]);
    expect(a).toBe(b);
    expect(await chooseRoute(target, { fetch, connect, cache })).toBe(a);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(fetch.calls).toHaveLength(1);
    links[0].fire();
    expect(await chooseRoute(target, { fetch, connect, cache })).toEqual({ kind: 'webrtc', connection: links[1] });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed choice, so the next call tries again', async () => {
    const cache = new Map<string, Promise<Route>>();
    const connect = vi.fn(async (): Promise<RtcLink> => {
      throw new Error('unreachable');
    });
    const target = { base: '', nasId: NAS_ID };
    await expect(chooseRoute(target, { fetch: healthFetch('ok'), connect, cache })).rejects.toThrow('unreachable');
    expect(cache.size).toBe(0);
  });
});

describe('chooseWebRtc', () => {
  it('replaces a cached HTTPS choice with WebRTC, with no health check, and later choices share it', async () => {
    const fetch = healthFetch('ok');
    const cache = new Map<string, Promise<Route>>();
    expect(await chooseRoute({ base: BASE, nasId: NAS_ID }, { fetch, connect: async () => fakeLink(), cache })).toEqual({ kind: 'https', base: BASE });
    const link = fakeLink();
    const connect = vi.fn(async () => link);
    const route = await chooseWebRtc({ base: BASE, nasId: NAS_ID }, { fetch, connect, cache });
    expect(route).toEqual({ kind: 'webrtc', connection: link });
    expect(fetch.calls).toHaveLength(1); // only the first choice's
    expect(await chooseRoute({ base: BASE, nasId: NAS_ID }, { fetch, connect, cache })).toBe(route);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('shares an open WebRTC choice, connects again once it has closed, and fails without a WebRTC id', async () => {
    const cache = new Map<string, Promise<Route>>();
    const first = fakeLink();
    const second = fakeLink();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const deps = { fetch: healthFetch('refused'), connect, cache };
    const [a, b] = await Promise.all([chooseWebRtc({ base: '', nasId: NAS_ID }, deps), chooseWebRtc({ base: '', nasId: NAS_ID }, deps)]);
    expect(a.connection).toBe(first);
    expect(b.connection).toBe(first);
    Object.assign(first, { closed: true });
    first.fire();
    expect((await chooseWebRtc({ base: '', nasId: NAS_ID }, deps)).connection).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
    await expect(chooseWebRtc({ base: BASE }, deps)).rejects.toThrow();
  });
});
