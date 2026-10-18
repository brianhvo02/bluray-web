import type { OwnerChoice, TitleKind } from '../../../src/engine/disc/nas-api';
import type { Auth } from '../auth';
import { formatCode, pairingLink } from '../codes';
import type { CodeRegistrar } from '../codes';
import { HttpError, json, readJson } from '../http';
import type { Handler, Response } from '../http';
import type { Library } from '../library';
import type { DiscEvidence } from '../titles/evidence';
import { groupKey } from '../titles/match';
import { parseName } from '../titles/parse-name';
import { SourceUnavailable } from '../titles/sources';
import type { TitleLibrary } from './titles';

export interface AdminOptions {
  library: Library;
  /** The `https` route registered with each code: this server's public API base. */
  publicBase: string;
  /** Absent until the rendezvous client exists: codes then come back with `rendezvous: false`. */
  registrar?: CodeRegistrar;
  /** How long a code waits for its rendezvous registration before it is returned with `rendezvous: false`. */
  registrarDeadlineMs?: number;
  /** The title library; its owner routes answer 404 without it. */
  titles?: TitleLibrary;
  now?: () => number;
  /** How long an owner's lookup may take before it answers 503. Default 10 s. */
  lookupTimeoutMs?: number;
}

const REGISTRAR_DEADLINE_MS = 5_000;

/** `promise`, or a rejection once `ms` have passed. */
async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The bearer token of `Authorization`, if any. */
export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1]! : null;
}

/** `/api/admin/*`, for owner devices only; the token must come as `Authorization: Bearer`. */
export function adminRoutes(auth: Auth, opts: AdminOptions): Handler {
  const lookups = new LookupLimiter(opts.now ?? Date.now);
  return async (req, url) => {
    const path = url.pathname;
    if (path !== '/api/admin' && !path.startsWith('/api/admin/')) return null;
    const token = bearerToken(req.headers.authorization);
    const device = token === null ? null : auth.verify(token);
    if (!device) return json(401, { error: 'unauthorized' });
    if (!device.owner) return json(403, { error: 'forbidden' });

    const [, , , collection, id, ...rest] = path.split('/');
    if (rest.length > 0) {
      // the one three-segment route
      if (opts.titles && collection === 'discs' && rest.length === 1 && rest[0] === 'choice') return choiceRoute(req.method, decode(id!), req, opts.library, opts.titles);
      return null;
    }
    const route = `${req.method} ${collection ?? ''}${id === undefined ? '' : '/:id'}`;
    if (opts.titles) {
      if (route === 'GET lookup') return lookupRoute(url, device.id, opts.titles, lookups, opts.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
      const answer = await titleAdminRoute(route, id === undefined ? undefined : decode(id), req, url, opts.library, opts.titles);
      if (answer) return answer;
    }
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
            await withDeadline(
              opts.registrar.registerCode(record.hash, { https: opts.publicBase }, record.expiresAt),
              opts.registrarDeadlineMs ?? REGISTRAR_DEADLINE_MS,
              'rendezvous registration',
            );
            rendezvous = true;
          } catch (err) {
            console.error('rendezvous registration failed', err);
          }
        }
        return json(200, { code: formatCode(code), link: pairingLink(code), expiresAt: record.expiresAt, rendezvous });
      }
      case 'DELETE devices/:id': {
        const target = decode(id!);
        const devices = auth.devices();
        const found = devices.find((d) => d.id === target);
        if (!found) return json(404, { error: 'unknown device' });
        // Synchronous from here to the revoke, so two owners can't remove each other at once. `owner-code` recovers anyway.
        if (found.owner && devices.filter((d) => d.owner).length === 1) return json(409, { error: 'last-owner' });
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

const MAX_NAME = 200;
const MAX_QUERY = 200;
const MAX_NUMBER = 1000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
/** Ids a choice may file a disc under: a source entry or an own title. */
const TITLE_ID = /^(?:anilist:\d+|tmdb-(?:tv|movie):\d+|own:[0-9a-f-]{36})$/;
const KINDS: readonly TitleKind[] = ['series', 'movie', 'music'];
const LOOKUP_TIMEOUT_MS = 10_000;
const LOOKUPS_PER_MINUTE = 20;
const MINUTE_MS = 60_000;

/** Per device: one lookup in flight and 20 started in any minute (ruling T9h). */
class LookupLimiter {
  private readonly busy = new Set<string>();
  private readonly starts = new Map<string, number[]>();

  constructor(private readonly now: () => number) {}

  /** Starts a lookup for `device`, or the 429 that refuses it. Call `done` once it ends. */
  start(device: string): Response | null {
    if (this.busy.has(device)) return json(429, { error: 'lookup-busy' });
    const t = this.now();
    for (const [d, ts] of this.starts) {
      const live = ts.filter((s) => s > t - MINUTE_MS);
      if (live.length === 0) this.starts.delete(d);
      else this.starts.set(d, live);
    }
    const mine = this.starts.get(device) ?? [];
    if (mine.length >= LOOKUPS_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil((mine[0]! + MINUTE_MS - t) / 1000));
      return json(429, { error: 'too-many-lookups' }, { 'Retry-After': String(wait) });
    }
    this.starts.set(device, [...mine, t]);
    this.busy.add(device);
    return null;
  }

  done(device: string): void {
    this.busy.delete(device);
  }
}

/** `GET admin/lookup?q&source`: paced ahead of matching, limited per device, given up after `timeoutMs` (ruling T9h). */
async function lookupRoute(url: URL, device: string, titles: TitleLibrary, limiter: LookupLimiter, timeoutMs: number): Promise<Response> {
  const q = url.searchParams.get('q')?.trim() ?? '';
  const source = url.searchParams.get('source');
  if (q.length < 1 || q.length > MAX_QUERY || (source !== 'anilist' && source !== 'tmdb' && source !== 'own')) throw new HttpError(400, 'bad query');
  // own titles are searched locally, so they are not limited
  const limited = source !== 'own';
  const refused = limited ? limiter.start(device) : null;
  if (refused) return refused;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new SourceUnavailable(`lookup took over ${timeoutMs} ms`)), timeoutMs);
  try {
    const timedOut = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason as Error), { once: true }));
    return json(200, { titles: await Promise.race([titles.service.lookup(q, source, abort.signal), timedOut]) });
  } catch (err) {
    if (err instanceof SourceUnavailable) return json(503, { error: 'source-unreachable' });
    throw err;
  } finally {
    clearTimeout(timer);
    if (limited) limiter.done(device);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Exactly these keys, the optional ones may be absent. */
const hasKeys = (o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((k) => k in o) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const isCount = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_NUMBER);
/** A trimmed name of 1 to 200 characters, or undefined. */
function name(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length >= 1 && t.length <= MAX_NAME ? t : undefined;
}

function parseChoice(v: unknown): OwnerChoice | null {
  if (!isObject(v)) return null;
  switch (v.kind) {
    case 'title':
      return hasKeys(v, ['kind', 'titleId', 'season', 'disc']) && typeof v.titleId === 'string' && TITLE_ID.test(v.titleId) && isCount(v.season) && isCount(v.disc)
        ? { kind: 'title', titleId: v.titleId, season: v.season, disc: v.disc }
        : null;
    case 'extras':
      return hasKeys(v, ['kind', 'titleId', 'season']) && typeof v.titleId === 'string' && TITLE_ID.test(v.titleId) && isCount(v.season)
        ? { kind: 'extras', titleId: v.titleId, season: v.season }
        : null;
    case 'music': {
      if (!hasKeys(v, ['kind', 'name'])) return null;
      if (v.name === null) return { kind: 'music', name: null };
      const n = name(v.name);
      return n === undefined ? null : { kind: 'music', name: n };
    }
    case 'hidden':
      return hasKeys(v, ['kind']) ? { kind: 'hidden' } : null;
    default:
      return null;
  }
}

/** The disc or volume number a disc's own folder or titles carry, for "parsed order" (spec §8). */
function parsedNumber(e: DiscEvidence): number | null {
  for (const text of [e.path.slice(e.path.lastIndexOf('/') + 1), ...e.discTitles.map((t) => t.name)]) {
    const p = parseName(text);
    const n = p.volume ?? p.disc;
    if (n !== null) return n;
  }
  return null;
}

const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/**
 * After an owner change: the catalogue is built again at once (ruling T9a); a choice naming an entry that isn't loaded
 * (its disc stays Unsorted as `no-title`) also starts a run in the background to load it.
 */
function rebuildAfter(titles: TitleLibrary, library: Library, discId?: string, choice?: OwnerChoice): void {
  // copies follow at once (ruling T9g)
  titles.owner.reattach(library.evidence().map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
  titles.service.rebuild();
  if (discId === undefined || choice === undefined || (choice.kind !== 'title' && choice.kind !== 'extras') || choice.titleId.startsWith('own:')) return;
  if (titles.service.catalogue().unsorted.some((u) => u.discId === discId && u.reason === 'no-title')) {
    titles.service.runNow().catch((err: unknown) => console.error('title matching failed', err));
  }
}

/** `PUT` and `DELETE admin/discs/<id>/choice`. */
async function choiceRoute(method: string | undefined, discId: string, req: Parameters<Handler>[0], library: Library, titles: TitleLibrary): Promise<Response | null> {
  const { owner } = titles;
  if (method === 'DELETE') {
    const origin = owner.choiceOrigin(discId);
    // a copy's choice follows its source, so clearing it would not last (ruling T9b); with no source left, it can go
    if (origin?.kind === 'copy' && origin.source !== null) return json(409, { error: 'copy-follows-source', source: origin.source });
    owner.clearChoice(discId);
    rebuildAfter(titles, library);
    return { status: 204 };
  }
  if (method !== 'PUT') return null;
  const body = await readJson(req);
  const choice = isObject(body) && hasKeys(body, ['choice'], ['applyToGroup']) ? parseChoice(body.choice) : null;
  const applyToGroup = isObject(body) ? (body.applyToGroup ?? false) : false;
  if (choice === null || typeof applyToGroup !== 'boolean') throw new HttpError(400, 'bad choice');
  // the other discs are numbered from this one's number (ruling T11h, M12)
  if (applyToGroup && choice.kind === 'title' && choice.disc === null) throw new HttpError(400, 'disc-required');
  const evidence = library.evidence();
  const disc = evidence.find((e) => e.discId === discId);
  if (!disc) return json(404, { error: 'unknown disc' });
  if (choice.kind === 'title' || choice.kind === 'extras') {
    if (choice.titleId.startsWith('own:') && !owner.snapshot().ownTitles.some((t) => t.id === choice.titleId)) throw new HttpError(400, 'unknown title');
  }
  owner.setChoice(discId, disc.fingerprint, choice);
  const skipped: { discId: string; reason: 'direct' | 'copy' | 'no-number' | 'conflict' }[] = [];
  if (applyToGroup) {
    // the group's discs in parsed order (number, then folder). A disc the owner chose for itself keeps its choice,
    // while one filed with a group takes the new one (ruling T9f); a copy keeps following its source while there is
    // one (ruling T9i). Under a title, the others are numbered by their own numbers, keeping their distance from this
    // one's (I3): a missing volume leaves a gap. Only when no disc in the group has a number are they numbered by
    // place; when some have one, those without are left as they are ('no-number'). When this disc has no number of its
    // own, the others keep theirs, and one that would take the number given here is left as it is ('conflict', N3).
    const group = groupKey(disc);
    const order = evidence
      .filter((e) => groupKey(e) === group)
      .sort((a, b) => (parsedNumber(a) ?? Infinity) - (parsedNumber(b) ?? Infinity) || naturalOrder(a.path, b.path));
    const at = order.indexOf(disc);
    const own = parsedNumber(disc);
    const anyNumber = order.some((e) => parsedNumber(e) !== null);
    for (const [i, e] of order.entries()) {
      if (e === disc) continue;
      const origin = owner.choiceOrigin(e.discId);
      if (origin?.kind === 'direct' || (origin?.kind === 'copy' && origin.source !== null)) {
        skipped.push({ discId: e.discId, reason: origin.kind });
        continue;
      }
      let c: OwnerChoice = choice;
      if (choice.kind === 'title' && choice.disc !== null) {
        const theirs = parsedNumber(e);
        const n = theirs !== null ? (own !== null ? theirs - own + choice.disc : theirs) : anyNumber ? null : choice.disc + i - at;
        if (own === null && theirs !== null && theirs === choice.disc) {
          skipped.push({ discId: e.discId, reason: 'conflict' });
          continue;
        }
        if (n === null || n < 1) {
          skipped.push({ discId: e.discId, reason: 'no-number' });
          continue;
        }
        c = { ...choice, disc: n };
      }
      owner.setChoice(e.discId, e.fingerprint, c, 'group');
    }
  }
  rebuildAfter(titles, library, discId, choice);
  return applyToGroup ? json(200, { skipped }) : { status: 204 };
}

/** The owner's title routes (spec §9, §11), or null for another route. `id` is decoded. */
async function titleAdminRoute(route: string, id: string | undefined, req: Parameters<Handler>[0], url: URL, library: Library, titles: TitleLibrary): Promise<Response | null> {
  const { service, owner } = titles;
  switch (route) {
    case 'GET unsorted': {
      const page = (key: string, fallback: number, max: number): number => {
        const raw = url.searchParams.get(key);
        if (raw === null) return fallback;
        const n = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(n) || n > max) throw new HttpError(400, 'bad paging');
        return n;
      };
      const offset = page('offset', 0, Number.MAX_SAFE_INTEGER);
      const limit = page('limit', DEFAULT_PAGE, MAX_PAGE);
      const all = service.catalogue().unsorted;
      return json(200, { items: all.slice(offset, offset + limit), total: all.length });
    }
    case 'GET hidden':
      return json(200, { discs: service.catalogue().hidden });
    case 'PUT names/:id': {
      const body = await readJson(req);
      const value = isObject(body) && hasKeys(body, ['name']) ? (body.name === null ? null : name(body.name)) : undefined;
      if (value === undefined) throw new HttpError(400, 'bad name');
      const music = service.catalogue().titles.some((t) => t.id === id && t.kind === 'music' && !t.own);
      const known = music || library.evidence().some((e) => e.discId === id);
      if (!known) return json(404, { error: 'unknown id' });
      owner.setDisplayName(id!, value);
      // a music title's id comes from its folder; the name is also kept in each disc's music choice, which follows the
      // disc when the folder moves (M8). A copy keeps following its source.
      if (music) {
        const byId = new Map(library.evidence().map((e) => [e.discId, e]));
        const detail = service.catalogue().detail(id!);
        const discIds = [...(detail?.seasons ?? []).flatMap((s) => s.discs), ...(detail?.extras ?? [])].flatMap((slot) => slot.copies.map((c) => c.discId));
        for (const discId of discIds) {
          const origin = owner.choiceOrigin(discId);
          if (origin?.kind === 'copy' && origin.source !== null) continue;
          const had = owner.snapshot().choices.get(discId);
          if (value === null && had?.kind !== 'music') continue;
          owner.setChoice(discId, byId.get(discId)?.fingerprint ?? null, { kind: 'music', name: value }, origin?.kind === 'group' ? 'group' : 'direct');
        }
      }
      rebuildAfter(titles, library);
      return { status: 204 };
    }
    case 'POST titles': {
      const body = await readJson(req);
      if (!isObject(body) || !hasKeys(body, ['kind', 'name'], ['seasons'])) throw new HttpError(400, 'bad title');
      const kind = KINDS.find((k) => k === body.kind);
      const n = name(body.name);
      const seasons = body.seasons ?? null;
      if (kind === undefined || n === undefined || !isCount(seasons) || (kind !== 'series' && seasons !== null)) throw new HttpError(400, 'bad title');
      const title = owner.createTitle(kind, n, seasons);
      rebuildAfter(titles, library);
      return json(200, title);
    }
    case 'PATCH titles/:id': {
      const body = await readJson(req);
      if (!isObject(body) || !hasKeys(body, [], ['name', 'seasons']) || Object.keys(body).length === 0) throw new HttpError(400, 'bad title');
      const n = body.name === undefined ? undefined : name(body.name);
      if (body.name !== undefined && n === undefined) throw new HttpError(400, 'bad title');
      if (body.seasons !== undefined && !isCount(body.seasons)) throw new HttpError(400, 'bad title');
      const existing = owner.snapshot().ownTitles.find((t) => t.id === id);
      if (!existing) return json(404, { error: 'unknown title' });
      if (existing.kind !== 'series' && body.seasons !== undefined && body.seasons !== null) throw new HttpError(400, 'bad title');
      const title = owner.updateTitle(existing.id, { ...(n !== undefined ? { name: n } : {}), ...(body.seasons !== undefined ? { seasons: body.seasons as number | null } : {}) });
      rebuildAfter(titles, library);
      return json(200, title);
    }
    case 'DELETE titles/:id': {
      if (!owner.snapshot().ownTitles.some((t) => t.id === id)) return json(404, { error: 'unknown title' });
      owner.deleteTitle(id!);
      rebuildAfter(titles, library);
      return { status: 204 };
    }
    case 'PUT settings/:id': {
      if (id !== 'title-library') return null;
      const body = await readJson(req);
      const gate = isObject(body) && hasKeys(body, ['gate']) ? body.gate : undefined;
      if (gate !== 'owners' && gate !== 'everyone') throw new HttpError(400, 'bad gate');
      owner.setGate(gate);
      return { status: 204 };
    }
    case 'GET metadata/:id':
      return id === 'status' ? json(200, service.status()) : null;
    default:
      return null;
  }
}
