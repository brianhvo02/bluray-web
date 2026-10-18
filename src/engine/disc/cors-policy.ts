/** The CORS rules the NAS server and the rendezvous Worker share; pure, so either runtime can use it. */

/**
 * Origins the player is served from: production, Pages previews and local dev/preview (4183 is the E2E preview port a
 * second checkout uses, E2E_PORT in playwright.config.ts, so nas.spec.ts runs there too).
 */
const ALLOWED_ORIGIN = /^(https:\/\/([a-z0-9-]+\.)?bluray-web\.pages\.dev|http:\/\/localhost:(5173|4173|4183))$/;

/** CORS headers for a response to `origin`; every response carries `Vary` and CORP. */
export function corsHeaders(origin: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  if (origin != null && ALLOWED_ORIGIN.test(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/** How long a browser may cache a preflight answer, in seconds. */
export const PREFLIGHT_MAX_AGE = '600';
