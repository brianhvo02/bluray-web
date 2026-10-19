import type { RtcLink } from './rtc/rtc-connection';

/** How long the HTTPS route's health check may take before WebRTC is tried. */
export const HEALTH_TIMEOUT_MS = 2_000;

/** How this device reaches a NAS. */
export type Route = { readonly kind: 'https'; readonly base: string } | { readonly kind: 'webrtc'; readonly connection: RtcLink };

/** What the choice needs of a pairing: the HTTPS base (or '' when unknown) and the WebRTC id, when known. */
export interface RouteTarget {
  readonly base: string;
  readonly nasId?: string;
}

export interface RouteDeps {
  readonly fetch: typeof fetch;
  /** Opens a WebRTC connection to the NAS `nasId`. */
  readonly connect: (nasId: string) => Promise<RtcLink>;
  /** Choices per NAS, for the page's life; a WebRTC choice is dropped when its connection closes. */
  readonly cache?: Map<string, Promise<Route>>;
}

/** The cache key of a NAS. */
export const routeKey = (target: RouteTarget): string => target.nasId ?? target.base;

/** Whether `GET <base>health` answers OK within 2 s. */
async function healthy(base: string, doFetch: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    return (await doFetch(`${base}health`, { signal: controller.signal })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function choose(target: RouteTarget, deps: RouteDeps): Promise<Route> {
  const { base, nasId } = target;
  // Without a WebRTC id there is nothing else to try, and HTTPS keeps its own (longer) first-request wait.
  if (nasId === undefined) return { kind: 'https', base };
  if (base !== '' && (await healthy(base, deps.fetch))) return { kind: 'https', base };
  return { kind: 'webrtc', connection: await deps.connect(nasId) };
}

/**
 * HTTPS first, when its health check answers within 2 s, then WebRTC. With `deps.cache`, concurrent and later calls
 * for the same NAS share the choice; a failed choice is forgotten, and so is a WebRTC one once its connection closes,
 * so the next call chooses again.
 */
export function chooseRoute(target: RouteTarget, deps: RouteDeps): Promise<Route> {
  const { cache } = deps;
  const key = routeKey(target);
  const cached = cache?.get(key);
  if (cached) return cached;
  const choice = choose(target, deps);
  if (cache) {
    cache.set(key, choice);
    choice.then(
      (route) => {
        if (route.kind === 'webrtc')
          route.connection.onClose(() => {
            if (cache.get(key) === choice) cache.delete(key);
          });
      },
      () => {
        if (cache.get(key) === choice) cache.delete(key);
      },
    );
  }
  return choice;
}
