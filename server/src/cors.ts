/** Origins the player is served from: production, Pages previews and local dev/preview. */
const ALLOWED_ORIGIN = /^(https:\/\/([a-z0-9-]+\.)?bluray-web\.pages\.dev|http:\/\/localhost:(5173|4173))$/;

/** CORS headers for a response to `origin`; every response carries `Vary` and CORP. */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  if (origin !== undefined && ALLOWED_ORIGIN.test(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/** Extra headers for a preflight answer. */
export const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
  'Access-Control-Max-Age': '600',
};
