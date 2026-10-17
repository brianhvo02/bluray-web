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

// Navigations are network-first, so a deploy shows up on the next visit; offline they fall back to the cached shell.
// Registered before the precache route so it wins for '/' as well.
registerRoute(
  new NavigationRoute(async ({ request }) => {
    try {
      return withIsolation(await fetch(request));
    } catch (e) {
      const shell = await matchPrecache('/index.html');
      if (!shell) throw e;
      return withIsolation(shell);
    }
  }),
);

addPlugins([{ handlerWillRespond: async ({ response }) => withIsolation(response) }]);
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'skip-waiting') void self.skipWaiting();
});
