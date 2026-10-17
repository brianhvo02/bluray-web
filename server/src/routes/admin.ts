import type { Auth } from '../auth';
import { formatCode, pairingLink } from '../codes';
import type { CodeRegistrar } from '../codes';
import { HttpError, json, readJson } from '../http';
import type { Handler } from '../http';
import type { Library } from '../library';

export interface AdminOptions {
  library: Library;
  /** The `https` route registered with each code: this server's public API base. */
  publicBase: string;
  /** Absent until the rendezvous client exists: codes then come back with `rendezvous: false`. */
  registrar?: CodeRegistrar;
}

/** The bearer token of `Authorization`, if any. */
export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1]! : null;
}

/** `/api/admin/*`, for owner devices only; the token must come as `Authorization: Bearer`. */
export function adminRoutes(auth: Auth, opts: AdminOptions): Handler {
  return async (req, url) => {
    const path = url.pathname;
    if (path !== '/api/admin' && !path.startsWith('/api/admin/')) return null;
    const token = bearerToken(req.headers.authorization);
    const device = token === null ? null : auth.verify(token);
    if (!device) return json(401, { error: 'unauthorized' });
    if (!device.owner) return json(403, { error: 'forbidden' });

    const [, , , collection, id, ...rest] = path.split('/');
    if (rest.length > 0) return null;
    const route = `${req.method} ${collection ?? ''}${id === undefined ? '' : '/:id'}`;
    switch (route) {
      case 'GET devices':
        return json(200, {
          devices: auth.devices().map(({ id, name, owner, pairedAt, lastSeen }) => ({ id, name, owner, pairedAt, lastSeen })),
        });
      case 'GET codes':
        return json(200, { codes: auth.codes().map(({ id, owner, expiresAt }) => ({ id, owner, expiresAt })) });
      case 'POST codes': {
        const body = await readJson(req);
        const owner = (body as { owner?: unknown } | null)?.owner;
        if (typeof owner !== 'boolean') throw new HttpError(400, 'bad request');
        const { record, code } = auth.createCode({ owner });
        let rendezvous = false;
        if (opts.registrar) {
          try {
            await opts.registrar.registerCode(record.hash, { https: opts.publicBase }, record.expiresAt);
            rendezvous = true;
          } catch (err) {
            console.error('rendezvous registration failed', err);
          }
        }
        return json(200, { code: formatCode(code), link: pairingLink(code), expiresAt: record.expiresAt, rendezvous });
      }
      case 'DELETE devices/:id': {
        const target = decode(id!);
        if (!auth.devices().some((d) => d.id === target)) return json(404, { error: 'unknown device' });
        auth.revokeDevice(target);
        return { status: 204 };
      }
      case 'DELETE codes/:id': {
        const target = decode(id!);
        if (!auth.codes().some((c) => c.id === target)) return json(404, { error: 'unknown code' });
        auth.deleteCode(target);
        return { status: 204 };
      }
      case 'POST rescan':
        opts.library.scan().catch((err: unknown) => console.error('library scan failed', err));
        return json(202, { scanning: true });
      default:
        return null;
    }
  };
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'bad request');
  }
}
