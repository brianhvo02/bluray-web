import type { Auth } from './auth';
import type { BdjStore } from './bdj-store';
import type { CodeRegistrar } from './codes';
import { json } from './http';
import type { Handler } from './http';
import type { Library } from './library';
import { adminRoutes, bearerToken } from './routes/admin';
import { bdjStoreRoutes } from './routes/bdj-store';
import { discRoutes } from './routes/discs';
import { libraryRoute } from './routes/library';
import { pairRoutes } from './routes/pair';
import type { RelayState } from './rtc/relay';
import { titleRoutes } from './routes/titles';
import type { TitleLibrary } from './routes/titles';

export interface AppOptions {
  auth: Auth;
  library: Library;
  /** Each person's BD-J saved data (spec §5). */
  bdjStore: BdjStore;
  publicBase: string;
  registrar?: CodeRegistrar;
  registrarDeadlineMs?: number;
  now?: () => number;
  /** Whether a peer is the reverse proxy, whose `X-Forwarded-For` names the client (see `trustedProxy`). Default: no peer. */
  trustProxy?: (address: string) => boolean;
  /** The title library: without it, its routes answer 404. */
  titles?: TitleLibrary;
  /** The Cloudflare relay's settings and usage (admin, and `me`). */
  relay?: RelayState;
  /** How long an owner's lookup may take. Default 10 s. */
  lookupTimeoutMs?: number;
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
    pairRoutes(auth, { now: opts.now ?? Date.now, trustProxy: opts.trustProxy ?? (() => false), registrar: opts.registrar }),
    requireToken(auth),
    bdjStoreRoutes(auth, opts.bdjStore),
    adminRoutes(auth, {
      library: opts.library, bdjStore: opts.bdjStore, publicBase: opts.publicBase, registrar: opts.registrar, registrarDeadlineMs: opts.registrarDeadlineMs,
      titles: opts.titles, relay: opts.relay, now: opts.now, lookupTimeoutMs: opts.lookupTimeoutMs,
    }),
    libraryRoute(opts.library),
    ...(opts.titles ? [titleRoutes(auth, opts.titles, opts.relay)] : []),
    discRoutes(opts.library),
  ];
}
