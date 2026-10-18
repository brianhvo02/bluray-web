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

function fakeSource(results: Record<string, Entry[]>): MetadataSource & { down: boolean } {
  const byKey = new Map(Object.entries(results).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map(Object.values(results).flat().map((en) => [en.id, en]));
  const src = {
    down: false,
    async search(query: string): Promise<Entry[]> {
      if (src.down) throw new SourceUnavailable('down');
      return byKey.get(normalizeTitle(query)) ?? [];
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

async function start(opts: { gate?: 'owners' | 'everyone' } = {}): Promise<void> {
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
  const server = createServer(appHandlers({ auth, library, now: () => clock, publicBase: 'https://nas.example/bluray/api/', titles: { service, owner } }));
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
    expect(res.status).toBe(204);
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
