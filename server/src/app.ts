import type { Auth } from './auth';
import type { CodeRegistrar } from './codes';
import { json } from './http';
import type { Handler } from './http';
import type { Library } from './library';
import { adminRoutes, bearerToken } from './routes/admin';
import { discRoutes } from './routes/discs';
import { libraryRoute } from './routes/library';
import { pairRoutes } from './routes/pair';
import { titleRoutes } from './routes/titles';
import type { TitleLibrary } from './routes/titles';

export interface AppOptions {
  auth: Auth;
  library: Library;
  publicBase: string;
  registrar?: CodeRegistrar;
  registrarDeadlineMs?: number;
  now?: () => number;
  /** Whether a peer is the reverse proxy, whose `X-Forwarded-For` names the client (see `trustedProxy`). Default: no peer. */
  trustProxy?: (address: string) => boolean;
  /** The title library: without it, its routes answer 404. */
  titles?: TitleLibrary;
}

/** Answers 401 to any request without a valid token (`t=` query or `Authorization: Bearer`); lets the rest through. */
export function requireToken(auth: Auth): Handler {
  return async (req, url) => {
    const token = bearerToken(req.headers.authorization) ?? url.searchParams.get('t');
    return token !== null && auth.verify(token) ? null : json(401, { error: 'unauthorized' });
  };
}

/** Every route after health: pairing and sessions open, everything else behind a token. */
export function appHandlers(opts: AppOptions): Handler[] {
  const { auth } = opts;
  return [
    pairRoutes(auth, { now: opts.now ?? Date.now, trustProxy: opts.trustProxy ?? (() => false) }),
    requireToken(auth),
    adminRoutes(auth, { library: opts.library, publicBase: opts.publicBase, registrar: opts.registrar, registrarDeadlineMs: opts.registrarDeadlineMs, titles: opts.titles }),
    libraryRoute(opts.library),
    ...(opts.titles ? [titleRoutes(auth, opts.titles)] : []),
    discRoutes(opts.library),
  ];
}
