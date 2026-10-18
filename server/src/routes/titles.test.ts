import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTitle } from '../../../src/engine/disc/title-text';
import type { OwnTitle, TitleDetail, TitleSummary } from '../../../src/engine/disc/nas-api';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { createServer } from '../http';
import { Library } from '../library';
import { Store } from '../store';
import { ArtCache } from '../titles/art';
import { artIdOf } from '../titles/catalogue';
import type { DiscEvidence } from '../titles/evidence';
import { OwnerStore } from '../titles/owner-store';
import { TitleService } from '../titles/service';
import { SourceUnavailable } from '../titles/sources';
import type { Entry, EntryNames, MetadataSource } from '../titles/sources';

// Every title and path here is made up (ruling R4).

function entry(id: string, names: Partial<EntryNames>, more: Partial<Entry> = {}): Entry {
  const source = id.startsWith('anilist:') ? 'anilist' : 'tmdb';
  return {
    source, id, kind: id.startsWith('tmdb-movie:') ? 'movie' : 'series', format: source === 'anilist' ? 'TV' : null,
    names: { english: null, romaji: null, native: null, synonyms: [], ...names },
    animation: source === 'anilist' ? true : null, year: 2022, episodes: 12, runtimeMin: null, seasons: [], relations: [],
    poster: null, banner: null, ...more,
  };
}

function ev(path: string, titles: Record<string, string> = {}, fingerprint: string | null = null): DiscEvidence {
  return {
    discId: `id:${path}`, path, fingerprint, discTitles: Object.entries(titles).map(([lang, name]) => ({ lang, name })),
    segments: path.split('/').slice(1), catalogueNumbers: [], playlists: [],
  };
}

const POSTER = { small: 'https://img.example/ember-s.jpg', large: 'https://img.example/ember-l.jpg' };
const EMBER = entry('anilist:100', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' }, { poster: POSTER });
const A = ev('drv1/Anime/火斬りの剣/[BDMV][220629][火斬りの剣][Vol.1]', { jpn: '火斬りの剣' }, 'FA');
// a box of three unnumbered-by-name discs, listed out of order
const BOX = ['drv1/Misc/Quiet Harbor/Quiet Harbor Disc 3', 'drv1/Misc/Quiet Harbor/Quiet Harbor Disc 1', 'drv1/Misc/Quiet Harbor/Quiet Harbor Disc 2'].map((p, i) => ev(p, {}, `FB${i}`));
const COPY = ev('drv2/Downloads/Quiet.Harbor.D1', {}, 'FB1');

type SearchOpts = Parameters<MetadataSource['search']>[1];

function fakeSource(results: Record<string, Entry[]>): MetadataSource & { down: boolean; hold: Promise<void> | null; searches: { query: string; opts: SearchOpts }[]; extra: Entry[] } {
  const byKey = new Map(Object.entries(results).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map(Object.values(results).flat().map((en) => [en.id, en]));
  const src = {
    down: false,
    hold: null as Promise<void> | null,
    searches: [] as { query: string; opts: SearchOpts }[],
    extra: [] as Entry[],
    async search(query: string, opts?: SearchOpts): Promise<Entry[]> {
      src.searches.push({ query, opts });
      if (src.hold) await src.hold;
      if (src.down) throw new SourceUnavailable('down');
      return [...(byKey.get(normalizeTitle(query)) ?? []), ...(normalizeTitle(query) === 'many' ? src.extra : [])];
    },
    async entry(id: string): Promise<Entry | null> {
      if (src.down) throw new SourceUnavailable('down');
      return byId.get(id) ?? null;
    },
  };
  return src;
}

let tmp: string;
let clock: number;
let base = '';
let close: (() => void) | undefined;
let auth: Auth;
let owner: OwnerStore;
let service: TitleService;
let anilist: ReturnType<typeof fakeSource>;
let evidence: DiscEvidence[];
let artFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'title-routes-'));
  clock = 1_800_000_000_000;
});
afterEach(() => {
  close?.();
  service?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function start(opts: { gate?: 'owners' | 'everyone'; lookupTimeoutMs?: number } = {}): Promise<void> {
  const data = join(tmp, 'data');
  auth = new Auth(new Store(data), () => clock);
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  evidence = [A, ...BOX, COPY];
  vi.spyOn(library, 'evidence').mockImplementation(() => evidence);
  owner = new OwnerStore(data);
  anilist = fakeSource({ 火斬りの剣: [EMBER], 'Ember Blade': [EMBER] });
  artFetch = vi.fn(async () => new Response(Buffer.from('PNGDATA'), { headers: { 'Content-Type': 'image/png' } }));
  service = new TitleService({
    library, owner, dataDir: data, anilist, tmdb: null, discdb: { lookup: () => null },
    art: new ArtCache(join(data, 'art'), artFetch as unknown as typeof fetch), titleLibrary: opts.gate ?? 'owners',
    now: () => clock, setTimer: () => () => {},
  });
  await service.runNow();
  const server = createServer(appHandlers({ auth, library, now: () => clock, publicBase: 'https://nas.example/bluray/api/', titles: { service, owner }, lookupTimeoutMs: opts.lookupTimeoutMs }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    server.closeAllConnections();
  };
}

async function token(isOwner: boolean): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { code } = auth.createCode({ owner: isOwner });
  const device = auth.redeem(code, isOwner ? 'Mac' : 'Phone', jwk)!;
  const challenge = auth.challenge(device.id)!;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(challenge));
  return auth.startSession(device.id, challenge, Buffer.from(sig).toString('base64url'))!.token;
}

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const get = (path: string, t: string): Promise<Response> => fetch(`${base}${path}`, { headers: bearer(t) });
const send = (method: string, path: string, t: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method, headers: { ...bearer(t), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const artId = artIdOf(POSTER);

describe('title routes', () => {
  it('hides titles, detail and art from a guest with 404 while the gate is owners, and serves an owner', async () => {
    await start();
    const guest = await token(false);
    const own = await token(true);
    for (const path of ['/api/titles', '/api/titles/anilist%3A100', `/api/art/${artId}`]) {
      const res = await get(path, guest);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
      expect((await get(path, own)).status, path).toBe(200);
    }
    expect((await fetch(`${base}/api/titles`)).status).toBe(401);
  });

  it('serves a guest once the gate is everyone, set by the owner', async () => {
    await start();
    const guest = await token(false);
    const own = await token(true);
    expect((await send('PUT', '/api/admin/settings/title-library', own, { gate: 'everyone' })).status).toBe(204);
    const res = await get('/api/titles', guest);
    expect(res.status).toBe(200);
    const { titles } = (await res.json()) as { titles: TitleSummary[] };
    expect(titles.map((t) => t.id)).toContain('anilist:100');
    const detail = (await (await get('/api/titles/anilist%3A100', guest)).json()) as TitleDetail;
    expect(detail.title.poster).toBe(artId);
    expect((await get('/api/titles/anilist%3A999', guest)).status).toBe(404);
  });

  it("reports the effective gate in the matching status, and the owner's change to it", async () => {
    await start();
    const own = await token(true);
    expect(await (await get('/api/admin/metadata/status', own)).json()).toMatchObject({ gate: 'owners' });
    expect((await send('PUT', '/api/admin/settings/title-library', own, { gate: 'everyone' })).status).toBe(204);
    expect(await (await get('/api/admin/metadata/status', own)).json()).toMatchObject({ gate: 'everyone' });
  });

  it('serves a guest with the env gate at everyone', async () => {
    await start({ gate: 'everyone' });
    expect((await get('/api/titles', await token(false))).status).toBe(200);
  });

  it('serves art by query token with the stored type and immutable caching, and only catalogue ids', async () => {
    await start({ gate: 'everyone' });
    const t = await token(false);
    const res = await fetch(`${base}/api/art/${artId}?size=large&t=${encodeURIComponent(t)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=2592000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGDATA');
    expect(artFetch).toHaveBeenCalledWith(POSTER.large, expect.anything());
    for (const path of [`/api/art/${'0'.repeat(32)}`, '/api/art/..%2Fowner.json', `/api/art/${artId.toUpperCase()}`, `/api/art/${artId}?size=huge`]) {
      expect((await get(path, t)).status, path).toBe(404);
    }
    expect(artFetch).toHaveBeenCalledTimes(1);
  });

  it('reports both flags on GET /api/me', async () => {
    await start();
    expect(await (await get('/api/me', await token(false))).json()).toEqual({ owner: false, titleLibrary: false });
    expect(await (await get('/api/me', await token(true))).json()).toEqual({ owner: true, titleLibrary: true });
    owner.setGate('everyone');
    expect(await (await get('/api/me', await token(false))).json()).toEqual({ owner: false, titleLibrary: true });
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
  });
});

describe('owner title routes', () => {
  it('answers 403 to a guest on every new admin route', async () => {
    await start({ gate: 'everyone' });
    const guest = await token(false);
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/admin/unsorted'],
      ['GET', '/api/admin/hidden'],
      ['GET', '/api/admin/lookup?q=x&source=own'],
      ['PUT', `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`, { choice: { kind: 'hidden' } }],
      ['DELETE', `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`],
      ['PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, { name: 'x' }],
      ['POST', '/api/admin/titles', { kind: 'movie', name: 'x' }],
      ['PATCH', '/api/admin/titles/own:x', { name: 'x' }],
      ['DELETE', '/api/admin/titles/own:x'],
      ['PUT', '/api/admin/settings/title-library', { gate: 'everyone' }],
      ['GET', '/api/admin/metadata/status'],
    ];
    for (const [method, path, body] of calls) expect((await send(method, path, guest, body)).status, `${method} ${path}`).toBe(403);
    expect(owner.snapshot().gate).toBeNull();
    expect(owner.snapshot().choices.size).toBe(0);
  });

  it('files the rest of a group in parsed order with applyToGroup, skipping discs with their own choice', async () => {
    await start();
    const t = await token(true);
    const title = (await (await send('POST', '/api/admin/titles', t, { kind: 'series', name: 'Quiet Harbor', seasons: 1 })).json()) as OwnTitle;
    expect(title).toMatchObject({ kind: 'series', name: 'Quiet Harbor', seasons: 1 });
    const [d3, d1, d2] = BOX as [DiscEvidence, DiscEvidence, DiscEvidence];
    const choice = { kind: 'title', titleId: title.id, season: 1, disc: 1 };
    const res = await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, { choice, applyToGroup: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: [] });
    const { choices } = owner.snapshot();
    expect(choices.get(d1.discId)).toEqual(choice);
    expect(choices.get(d2.discId)).toEqual({ ...choice, disc: 2 });
    expect(choices.get(d3.discId)).toEqual({ ...choice, disc: 3 });
    expect(choices.has(A.discId)).toBe(false);
    // rebuilt at once: the next GET lists the title with its three discs
    const { titles } = (await (await get('/api/titles', t)).json()) as { titles: TitleSummary[] };
    expect(titles.find((x) => x.id === title.id)?.discs).toBe(3);

    // a disc with a direct choice of its own keeps it
    owner.clearChoice(d1.discId);
    owner.setChoice(d3.discId, d3.fingerprint, { kind: 'hidden' });
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d2.discId)}/choice`, t, { choice: { ...choice, disc: 5 }, applyToGroup: true });
    expect(owner.snapshot().choices.get(d1.discId)).toEqual({ ...choice, disc: 4 });
    expect(owner.snapshot().choices.get(d3.discId)).toEqual({ kind: 'hidden' });
    const hidden = (await (await get('/api/admin/hidden', t)).json()) as { discs: { discId: string }[] };
    expect(hidden.discs.map((d) => d.discId)).toEqual([d3.discId]);
  });

  it('starts a run when a choice names an entry that is not loaded, without waiting for it', async () => {
    await start();
    const t = await token(true);
    const run = vi.spyOn(service, 'runNow');
    const disc = BOX[1]!;
    await send('PUT', `/api/admin/discs/${encodeURIComponent(disc.discId)}/choice`, t, { choice: { kind: 'hidden' } });
    expect(run).not.toHaveBeenCalled();
    await send('PUT', `/api/admin/discs/${encodeURIComponent(disc.discId)}/choice`, t, { choice: { kind: 'title', titleId: 'anilist:777', season: 1, disc: 1 } });
    expect(run).toHaveBeenCalledOnce();
  });

  it('answers 409 when clearing a choice a copy follows from its source, and clears a direct one', async () => {
    await start();
    const t = await token(true);
    const d1 = BOX[1]!;
    owner.setChoice(d1.discId, d1.fingerprint, { kind: 'hidden' });
    owner.reattach(evidence.map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
    expect(owner.snapshot().choices.get(COPY.discId)).toEqual({ kind: 'hidden' });
    const res = await send('DELETE', `/api/admin/discs/${encodeURIComponent(COPY.discId)}/choice`, t);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'copy-follows-source', source: d1.discId });
    expect((await send('DELETE', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t)).status).toBe(204);
    expect(owner.snapshot().choices.has(d1.discId)).toBe(false);
  });

  it('looks up AniList through its source, own titles by name, and TMDB with no key as no titles', async () => {
    await start();
    const t = await token(true);
    const tmdb = await get('/api/admin/lookup?q=Ember&source=tmdb', t);
    expect(tmdb.status).toBe(200);
    expect(await tmdb.json()).toEqual({ titles: [] });
    const found = (await (await get('/api/admin/lookup?q=Ember%20Blade&source=anilist', t)).json()) as { titles: TitleSummary[] };
    expect(found.titles.map((x) => x.id)).toEqual(['anilist:100']);
    expect(found.titles[0]!.poster).toBe(artId);
    owner.createTitle('movie', 'Paper Lanterns', null);
    const own = (await (await get('/api/admin/lookup?q=paper&source=own', t)).json()) as { titles: TitleSummary[] };
    expect(own.titles.map((x) => x.names.display)).toEqual(['Paper Lanterns']);
    anilist.down = true;
    const down = await get('/api/admin/lookup?q=Other&source=anilist', t);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'source-unreachable' });
  });

  it('answers 400 with a fixed error to a bad body or query', async () => {
    await start();
    const t = await token(true);
    const disc = `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`;
    const bad: [string, string, unknown, string][] = [
      ['PUT', disc, { choice: { kind: 'title', titleId: 'anilist:1', season: 0, disc: 1 } }, 'bad choice'],
      ['PUT', disc, { choice: { kind: 'title', titleId: 'https://evil.example', season: 1, disc: 1 } }, 'bad choice'],
      ['PUT', disc, { choice: { kind: 'hidden', extra: 1 } }, 'bad choice'],
      ['PUT', disc, { choice: { kind: 'hidden' }, applyToGroup: 'yes' }, 'bad choice'],
      ['PUT', disc, { choice: { kind: 'title', titleId: 'own:00000000-0000-0000-0000-000000000000', season: null, disc: null } }, 'unknown title'],
      ['PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, { name: 'x'.repeat(201) }, 'bad name'],
      ['PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, { name: '  ' }, 'bad name'],
      ['POST', '/api/admin/titles', { kind: 'show', name: 'x' }, 'bad title'],
      ['POST', '/api/admin/titles', { kind: 'movie', name: 'x', seasons: 2 }, 'bad title'],
      ['PUT', '/api/admin/settings/title-library', { gate: 'all' }, 'bad gate'],
    ];
    for (const [method, path, body, error] of bad) {
      const res = await send(method, path, t, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    for (const q of ['q=&source=own', `q=${'x'.repeat(201)}&source=own`, 'q=x&source=web']) {
      const res = await get(`/api/admin/lookup?${q}`, t);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad query' });
    }
    expect(await (await get('/api/admin/unsorted?limit=-1', t)).json()).toEqual({ error: 'bad paging' });
    expect(owner.snapshot().choices.size).toBe(0);
  });

  it('pages Unsorted, renames, edits and deletes own titles, sets display names and reports status', async () => {
    await start();
    const t = await token(true);
    const page = (await (await get('/api/admin/unsorted?offset=1&limit=2', t)).json()) as { items: { discId: string }[]; total: number };
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(2);

    const created = (await (await send('POST', '/api/admin/titles', t, { kind: 'movie', name: ' Paper Lanterns ' })).json()) as OwnTitle;
    expect(created.name).toBe('Paper Lanterns');
    const patched = await send('PATCH', `/api/admin/titles/${encodeURIComponent(created.id)}`, t, { name: 'Paper Lanterns (Remaster)' });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as OwnTitle).name).toBe('Paper Lanterns (Remaster)');
    expect((await send('PATCH', '/api/admin/titles/own%3Anope', t, { name: 'x' })).status).toBe(404);
    expect((await send('DELETE', `/api/admin/titles/${encodeURIComponent(created.id)}`, t)).status).toBe(204);
    expect(owner.snapshot().ownTitles).toEqual([]);

    expect((await send('PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, t, { name: 'Volume One' })).status).toBe(204);
    expect(owner.snapshot().displayNames.get(A.discId)).toBe('Volume One');
    expect((await send('PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, t, { name: null })).status).toBe(204);
    expect(owner.snapshot().displayNames.has(A.discId)).toBe(false);
    expect((await send('PUT', '/api/admin/names/nope', t, { name: 'x' })).status).toBe(404);

    const status = await (await get('/api/admin/metadata/status', t)).json();
    expect(status).toMatchObject({ running: false, filed: 1, unsorted: 4, tmdb: false });
  });
});

describe('task 9 review', () => {
  const ADMIN_ROUTES: [string, string, unknown?][] = [
    ['GET', '/api/admin/unsorted'],
    ['GET', '/api/admin/hidden'],
    ['GET', '/api/admin/lookup?q=x&source=own'],
    ['PUT', `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`, { choice: { kind: 'hidden' } }],
    ['DELETE', `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`],
    ['PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, { name: 'x' }],
    ['POST', '/api/admin/titles', { kind: 'movie', name: 'x' }],
    ['PATCH', '/api/admin/titles/own:x', { name: 'x' }],
    ['DELETE', '/api/admin/titles/own:x'],
    ['PUT', '/api/admin/settings/title-library', { gate: 'everyone' }],
    ['GET', '/api/admin/metadata/status'],
  ];

  it('answers 401 on every new admin route with no token, and with an owner token sent as ?t=', async () => {
    await start();
    const t = await token(true);
    for (const [method, path, body] of ADMIN_ROUTES) {
      const init = { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
      expect((await fetch(`${base}${path}`, init)).status, `${method} ${path}`).toBe(401);
      const sep = path.includes('?') ? '&' : '?';
      expect((await fetch(`${base}${path}${sep}t=${encodeURIComponent(t)}`, init)).status, `${method} ${path} ?t=`).toBe(401);
    }
    expect(owner.snapshot().gate).toBeNull();
  });

  it('serves the art of lookup results to an owner, from a registry of at most 500 (ruling T9e)', async () => {
    await start({ gate: 'everyone' });
    const t = await token(true);
    const guest = await token(false);
    anilist.extra = Array.from({ length: 501 }, (_, i) =>
      entry(`anilist:${5000 + i}`, { english: `Lantern ${i}` }, { poster: { small: `https://img.example/l${i}-s.jpg`, large: `https://img.example/l${i}-l.jpg` } }));
    const { titles } = (await (await get('/api/admin/lookup?q=many&source=anilist', t)).json()) as { titles: TitleSummary[] };
    expect(titles).toHaveLength(501);
    const first = titles[0]!.poster!;
    const last = titles[500]!.poster!;
    expect(last).toBe(artIdOf(anilist.extra[500]!.poster!));
    const res = await get(`/api/art/${last}?size=large`, t);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=2592000, immutable');
    expect(artFetch).toHaveBeenLastCalledWith('https://img.example/l500-l.jpg', expect.anything());
    expect((await get(`/api/art/${last}`, guest)).status).toBe(404);
    expect((await get(`/api/art/${first}`, t)).status).toBe(404);
    // the catalogue's own art still serves everyone
    expect((await get(`/api/art/${artId}`, guest)).status).toBe(200);
  });

  it('lets a later applyToGroup correct group-filed discs, but not discs filed one by one (ruling T9f)', async () => {
    await start();
    const t = await token(true);
    const mk = async (n: string): Promise<OwnTitle> => (await (await send('POST', '/api/admin/titles', t, { kind: 'series', name: n, seasons: 1 })).json()) as OwnTitle;
    const wrong = await mk('Wrong Harbor');
    const right = await mk('Quiet Harbor');
    const [d3, d1, d2] = BOX as [DiscEvidence, DiscEvidence, DiscEvidence];
    const choice = (id: string, disc: number): unknown => ({ choice: { kind: 'title', titleId: id, season: 1, disc }, applyToGroup: true });
    const filed = (id: string, disc: number): unknown => ({ kind: 'title', titleId: id, season: 1, disc });
    const at = (d: DiscEvidence): unknown => owner.snapshot().choices.get(d.discId);
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, choice(wrong.id, 1));
    // applied again, from the same disc: the group-filed siblings follow
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, choice(right.id, 1));
    expect([d1, d2, d3].map(at)).toEqual([filed(right.id, 1), filed(right.id, 2), filed(right.id, 3)]);
    // a disc the owner filed one by one keeps its choice
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d3.discId)}/choice`, t, { choice: { kind: 'hidden' } });
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, choice(wrong.id, 1));
    expect([d1, d2, d3].map(at)).toEqual([filed(wrong.id, 1), filed(wrong.id, 2), { kind: 'hidden' }]);
    // a disc the owner acted on with applyToGroup is direct too
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d2.discId)}/choice`, t, choice(right.id, 2));
    expect(at(d1)).toEqual(filed(wrong.id, 1));
  });

  it('applies a choice to the copies at once (ruling T9g)', async () => {
    await start();
    const t = await token(true);
    await send('PUT', `/api/admin/discs/${encodeURIComponent(BOX[1]!.discId)}/choice`, t, { choice: { kind: 'hidden' } });
    const hidden = (await (await get('/api/admin/hidden', t)).json()) as { discs: { discId: string }[] };
    expect(hidden.discs.map((d) => d.discId).sort()).toEqual([BOX[1]!.discId, COPY.discId].sort());
  });

  it('clears a copy whose source is gone, with no 409', async () => {
    await start();
    const t = await token(true);
    const d1 = BOX[1]!;
    owner.setChoice(d1.discId, d1.fingerprint, { kind: 'hidden' });
    owner.reattach(evidence.map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
    owner.clearChoice(d1.discId);
    expect((await send('DELETE', `/api/admin/discs/${encodeURIComponent(COPY.discId)}/choice`, t)).status).toBe(204);
    expect(owner.snapshot().choices.has(COPY.discId)).toBe(false);
  });

  it('finds no own titles for a query that normalises to nothing', async () => {
    await start();
    const t = await token(true);
    owner.createTitle('movie', 'Paper Lanterns', null);
    expect(await (await get('/api/admin/lookup?q=!!!&source=own', t)).json()).toEqual({ titles: [] });
  });

  it('looks up ahead of background matching, one at a time and 20 a minute per device (ruling T9h)', async () => {
    await start();
    const t = await token(true);
    const other = await token(true);
    anilist.searches.length = 0; // the start's matching run
    let release!: () => void;
    anilist.hold = new Promise((r) => (release = r));
    const busy = get('/api/admin/lookup?q=Ember%20Blade&source=anilist', t);
    await vi.waitFor(() => expect(anilist.searches).toHaveLength(1));
    expect(anilist.searches[0]!.opts).toMatchObject({ urgent: true });
    expect(anilist.searches[0]!.opts?.signal).toBeInstanceOf(AbortSignal);
    const second = await get('/api/admin/lookup?q=Ember%20Blade&source=anilist', t);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: 'lookup-busy' });
    release();
    expect((await busy).status).toBe(200);
    anilist.hold = null;
    for (let i = 1; i < 20; i++) expect((await get('/api/admin/lookup?q=Ember&source=anilist', t)).status, `lookup ${i}`).toBe(200);
    clock += 30_000;
    const over = await get('/api/admin/lookup?q=Ember&source=anilist', t);
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('30');
    expect(await over.json()).toEqual({ error: 'too-many-lookups' });
    expect((await get('/api/admin/lookup?q=Ember&source=anilist', other)).status).toBe(200);
    clock += 30_000;
    expect((await get('/api/admin/lookup?q=Ember&source=anilist', t)).status).toBe(200);
  });

  it('skips siblings that are copies of a disc with a choice, and reports what it skipped (ruling T9i)', async () => {
    await start();
    const t = await token(true);
    const [d3, d1, d2] = BOX as [DiscEvidence, DiscEvidence, DiscEvidence];
    // a copy of A sits in the box's group
    const copyOfA = ev('drv1/Misc/Quiet Harbor/Quiet Harbor Disc 4', {}, A.fingerprint);
    evidence = [...evidence, copyOfA];
    owner.setChoice(A.discId, A.fingerprint, { kind: 'hidden' });
    owner.reattach(evidence.map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
    owner.setChoice(d3.discId, d3.fingerprint, { kind: 'hidden' });
    const title = (await (await send('POST', '/api/admin/titles', t, { kind: 'series', name: 'Quiet Harbor', seasons: 1 })).json()) as OwnTitle;
    const res = await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, {
      choice: { kind: 'title', titleId: title.id, season: 1, disc: 1 }, applyToGroup: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: [{ discId: d3.discId, reason: 'direct' }, { discId: copyOfA.discId, reason: 'copy' }] });
    expect(owner.choiceOrigin(copyOfA.discId)).toEqual({ kind: 'copy', source: A.discId });
    expect(owner.snapshot().choices.get(d2.discId)).toEqual({ kind: 'title', titleId: title.id, season: 1, disc: 2 });
    // without applyToGroup: 204 as before
    expect((await send('PUT', `/api/admin/discs/${encodeURIComponent(d2.discId)}/choice`, t, { choice: { kind: 'hidden' } })).status).toBe(204);
  });

  it('does not count own-title lookups against the per-device limits', async () => {
    await start();
    const t = await token(true);
    owner.createTitle('movie', 'Paper Lanterns', null);
    for (let i = 0; i < 25; i++) expect((await get('/api/admin/lookup?q=paper&source=own', t)).status, `own ${i}`).toBe(200);
    expect((await get('/api/admin/lookup?q=Ember&source=anilist', t)).status).toBe(200);
  });

  it('gives up on a lookup after its timeout with 503 source-unreachable', async () => {
    await start({ lookupTimeoutMs: 50 });
    const t = await token(true);
    anilist.searches.length = 0; // the start's matching run
    anilist.hold = new Promise(() => {});
    const res = await get('/api/admin/lookup?q=Ember&source=anilist', t);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'source-unreachable' });
    expect(anilist.searches[0]!.opts?.signal?.aborted).toBe(true);
    // the device may look up again
    anilist.hold = null;
    expect((await get('/api/admin/lookup?q=Ember&source=anilist', t)).status).toBe(200);
  });
});
