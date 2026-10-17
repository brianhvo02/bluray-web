import { addPlugins, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  readonly __WB_MANIFEST: ReadonlyArray<string | { readonly url: string; readonly revision: string | null }>;
};

/** SharedArrayBuffer (the audio ring) needs cross-origin isolation, online and offline. */
const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** A copy of `response` carrying the isolation headers. Opaque responses (status 0) cannot be rebuilt. */
function withIsolation(response: Response): Response {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** How long a navigation waits for the network before the cached shell is served instead. */
const NAVIGATION_TIMEOUT_MS = 3000;

/**
 * A navigation answer that means the app can't be had from the network: a client or server error status. Opaque
 * redirects (status 0) pass through, so the browser follows them.
 */
function navigationFailed(response: Response): boolean {
  return response.status >= 400;
}

/** The precached app shell, or the network response when the shell is missing. */
async function shellOr(network: Promise<Response>): Promise<Response> {
  const shell = await matchPrecache('/index.html');
  return withIsolation(shell ?? (await network));
}

// Navigations are network-first, so a deploy shows up on the next visit. Offline, when the network answers with an
// error status, or when it takes longer than NAVIGATION_TIMEOUT_MS, they get the cached shell. Registered before the precache route so it wins for '/' too.
// The diagnostics page is not precached and must never be answered with the player's shell.
registerRoute(
  new NavigationRoute(
    async ({ request }) => {
      const network = fetch(request);
      network.catch(() => undefined); // a late failure after the timeout is not an error
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
      });
      try {
        const response = await Promise.race([network, timeout]);
        // an error page from the server, a proxy or a CDN (404, 5xx) is as good as offline: the shell is cached
        if (response && !navigationFailed(response)) return withIsolation(response);
        if (response) return shellOr(Promise.resolve(response));
      } catch {
        // offline: fall through to the shell
      } finally {
        clearTimeout(timer);
      }
      return shellOr(network);
    },
    { denylist: [/^\/probe(\.html)?(\?.*)?$/] },
  ),
);

addPlugins([{ handlerWillRespond: async ({ response }) => withIsolation(response) }]);
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'skip-waiting') void self.skipWaiting();
});
