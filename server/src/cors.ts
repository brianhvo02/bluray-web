import { PREFLIGHT_MAX_AGE, corsHeaders } from '../../src/engine/disc/cors-policy';

export { corsHeaders };

/** Extra headers for a preflight answer. */
export const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
  'Access-Control-Max-Age': PREFLIGHT_MAX_AGE,
};
