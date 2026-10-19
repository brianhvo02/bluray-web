import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { appHandlers } from '../app';
import { Auth, INVITE_TTL_MS } from '../auth';
import type { PersonRef } from '../auth';
import { BdjStore } from '../bdj-store';
import { codeHash } from '../codes';
import type { CodeRegistrar } from '../codes';
import { createServer } from '../http';
import { Library } from '../library';
import { Store } from '../store';
import { writeTar } from '../tar';

// Every name here is made up.

const MINUTE = 60_000;
const SCOPE = 'persistent/0a1b2c3d';

let tmp: string;
let clock: number;
let base = '';
let close: (() => void) | undefined;
let auth: Auth;
let store: BdjStore;
let registrar: { registerCode: Mock<CodeRegistrar['registerCode']>; unregisterCode: Mock<CodeRegistrar['unregisterCode']> };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'admin-routes-'));
  clock = 1_800_000_000_000;
  const data = join(tmp, 'data');
  auth = new Auth(new Store(data), () => clock);
  store = new BdjStore(data);
  registrar = { registerCode: vi.fn(async () => {}), unregisterCode: vi.fn(async () => {}) };
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  const server = createServer(appHandlers({ auth, library, bdjStore: store, registrar, now: () => clock, publicBase: 'https://nas.example/bluray/api/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    server.closeAllConnections();
  };
});
afterEach(() => {
  close?.();
  rmSync(tmp, { recursive: true, force: true });
});

async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (text: string): Promise<string> =>
    Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text))).toString('base64url');
  return { jwk, sign };
}

const send = (method: string, path: string, token: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Redeems `code` over HTTP and starts a session: the redeem answer and a token. */
async function redeem(code: string, deviceName: string): Promise<{ redeemed: Record<string, unknown>; token: string }> {
  const { jwk, sign } = await deviceKey();
  const res = await post('/api/pair/redeem', { code, deviceName, publicKeyJwk: jwk });
  expect(res.status).toBe(200);
  const redeemed = (await res.json()) as Record<string, unknown>;
  const deviceId = redeemed.deviceId as string;
  const { challenge } = (await (await post('/api/session/challenge', { deviceId })).json()) as { challenge: string };
  const { token } = (await (await post('/api/session', { deviceId, challenge, signature: await sign(challenge) })).json()) as { token: string };
  return { redeemed, token };
}

async function paired(ref: PersonRef, deviceName: string): Promise<string> {
  return (await redeem(auth.createCode(ref).code, deviceName)).token;
}

const ownerToken = (): Promise<string> => paired({ personId: auth.firstOwnerPerson().id }, 'Mac');

interface PersonView {
  id: string;
  name: string;
  owner: boolean;
  createdAt: number;
  savedBytes: number;
  devices: { id: string; name: string; pairedAt: number; lastSeen: number; lastRoute?: string }[];
}

describe('admin people', () => {
  it('creates, lists, renames, makes owner and removes people', async () => {
    const owner = await ownerToken();
    const created = await send('POST', '/api/admin/people', owner, { name: ' Mika ' });
    expect(created.status).toBe(201);
    const mika = (await created.json()) as PersonView;
    expect(mika).toEqual({ id: expect.any(String), name: 'Mika', owner: false, createdAt: clock, savedBytes: 0, devices: [] });

    const list = (await (await send('GET', '/api/admin/people', owner)).json()) as { people: PersonView[] };
    expect(list.people.map((p) => [p.name, p.owner, p.devices.map((d) => d.name)])).toEqual([
      ['Owner', true, ['Mac']],
      ['Mika', false, []],
    ]);
    expect(Object.keys(list.people[0]!.devices[0]!).sort()).toEqual(['id', 'lastRoute', 'lastSeen', 'name', 'pairedAt']);

    const renamed = await send('PATCH', `/api/admin/people/${mika.id}`, owner, { name: 'Mika R', owner: true });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: mika.id, name: 'Mika R', owner: true });

    expect((await send('DELETE', `/api/admin/people/${mika.id}`, owner)).status).toBe(204);
    expect((await send('DELETE', `/api/admin/people/${mika.id}`, owner)).status).toBe(404);
    expect((await send('PATCH', `/api/admin/people/${mika.id}`, owner, { name: 'x' })).status).toBe(404);
  });

  it('refuses bad bodies with 400', async () => {
    const owner = await ownerToken();
    const [person] = auth.people();
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'Mika', owner: 'yes' }, { name: 'Mika', extra: 1 }]) {
      expect((await send('POST', '/api/admin/people', owner, body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const body of [{}, { name: '  ' }, { owner: 1 }, { colour: 'red' }]) {
      expect((await send('PATCH', `/api/admin/people/${person!.id}`, owner, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers 409 last-owner to unmaking, removing, moving off or revoking the last owner', async () => {
    const owner = await ownerToken();
    const ownerPerson = auth.firstOwnerPerson();
    const mika = auth.createPerson('Mika', false);
    const [mac] = auth.devices();
    const conflicts = [
      await send('PATCH', `/api/admin/people/${ownerPerson.id}`, owner, { owner: false }),
      await send('DELETE', `/api/admin/people/${ownerPerson.id}`, owner),
      await send('PATCH', `/api/admin/devices/${mac!.id}`, owner, { personId: mika.id }),
      await send('DELETE', `/api/admin/devices/${mac!.id}`, owner),
    ];
    for (const res of conflicts) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'last-owner' });
    }
  });

  it('moves a device to another person', async () => {
    const owner = await ownerToken();
    const phone = await paired({ newPerson: { name: 'Den TV', owner: false } }, 'Phone');
    const mika = auth.createPerson('Mika', false);
    const device = auth.devices().find((d) => d.name === 'Phone')!;
    expect((await send('PATCH', `/api/admin/devices/${device.id}`, owner, { personId: mika.id })).status).toBe(204);
    expect(auth.devices().find((d) => d.id === device.id)?.personName).toBe('Mika');
    expect((await send('GET', '/api/library', phone)).status).toBe(200);
    expect((await send('PATCH', `/api/admin/devices/nope`, owner, { personId: mika.id })).status).toBe(404);
    expect((await send('PATCH', `/api/admin/devices/${device.id}`, owner, { personId: 'nope' })).status).toBe(404);
    expect((await send('PATCH', `/api/admin/devices/${device.id}`, owner, { person: mika.id })).status).toBe(400);
  });

  it('lists devices with their person', async () => {
    const owner = await ownerToken();
    const { devices } = (await (await send('GET', '/api/admin/devices', owner)).json()) as { devices: Record<string, unknown>[] };
    expect(devices).toEqual([
      { id: expect.any(String), name: 'Mac', owner: true, personId: auth.firstOwnerPerson().id, personName: 'Owner', pairedAt: clock, lastSeen: clock },
    ]);
  });

  it('answers 403 to a guest on every people route', async () => {
    const guest = await paired({ newPerson: { name: 'Mika', owner: false } }, 'Phone');
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/admin/people'],
      ['POST', '/api/admin/people', { name: 'x' }],
      ['PATCH', '/api/admin/people/x', { name: 'x' }],
      ['DELETE', '/api/admin/people/x'],
      ['DELETE', '/api/admin/people/x/saved-data'],
      ['PATCH', '/api/admin/devices/x', { personId: 'x' }],
    ];
    for (const [method, path, body] of calls) expect((await send(method, path, guest, body)).status, `${method} ${path}`).toBe(403);
  });

  it('shows and clears saved data, and removing a person clears it', async () => {
    const owner = await ownerToken();
    const mikaToken = await paired({ newPerson: { name: 'Mika', owner: false } }, 'Phone');
    const mika = auth.people().find((p) => p.name === 'Mika')!;
    const tar = writeTar([{ path: 'save', data: Buffer.from('level 3'), mtime: 1 }]);
    const put = await fetch(`${base}/api/bdj-store/${SCOPE}`, { method: 'PUT', headers: { Authorization: `Bearer ${mikaToken}`, 'If-None-Match': '*' }, body: tar });
    expect(put.status).toBe(200);

    const savedBytes = async (): Promise<number> =>
      ((await (await send('GET', '/api/admin/people', owner)).json()) as { people: PersonView[] }).people.find((p) => p.id === mika.id)!.savedBytes;
    expect(await savedBytes()).toBe(tar.length);
    expect((await send('DELETE', `/api/admin/people/${mika.id}/saved-data`, owner)).status).toBe(204);
    expect(await savedBytes()).toBe(0);
    expect((await send('DELETE', '/api/admin/people/nope/saved-data', owner)).status).toBe(404);

    await fetch(`${base}/api/bdj-store/${SCOPE}`, { method: 'PUT', headers: { Authorization: `Bearer ${mikaToken}`, 'If-None-Match': '*' }, body: tar });
    expect(store.usage(mika.id)).toBe(tar.length);
    expect((await send('DELETE', `/api/admin/people/${mika.id}`, owner)).status).toBe(204);
    expect(store.usage(mika.id)).toBe(0);
  });

  it("locks a removed person's devices out of bdj-store and the library", async () => {
    const owner = await ownerToken();
    const mikaToken = await paired({ newPerson: { name: 'Mika', owner: false } }, 'Phone');
    const mika = auth.people().find((p) => p.name === 'Mika')!;
    expect((await send('GET', `/api/bdj-store/${SCOPE}`, mikaToken)).status).toBe(200);
    expect((await send('GET', '/api/library', mikaToken)).status).toBe(200);
    expect((await send('DELETE', `/api/admin/people/${mika.id}`, owner)).status).toBe(204);
    expect((await send('GET', `/api/bdj-store/${SCOPE}`, mikaToken)).status).toBe(401);
    expect((await send('GET', '/api/library', mikaToken)).status).toBe(401);
    expect((await fetch(`${base}/api/library?t=${encodeURIComponent(mikaToken)}`)).status).toBe(401);
  });
});

describe('admin codes', () => {
  it('mints a code for an existing person, and one that makes a new person', async () => {
    const owner = await ownerToken();
    const ownerPerson = auth.firstOwnerPerson();
    const res = await send('POST', '/api/admin/codes', owner, { personId: ownerPerson.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/), link: expect.any(String), expiresAt: clock + 10 * MINUTE,
      rendezvous: true, personId: ownerPerson.id, personName: 'Owner', invite: false,
    });
    expect(registrar.registerCode).toHaveBeenLastCalledWith(expect.any(String), { https: 'https://nas.example/bluray/api/' }, clock + 10 * MINUTE);

    const invite = (await (await send('POST', '/api/admin/codes', owner, { newPerson: { name: 'Mika', owner: false }, invite: true })).json()) as Record<string, unknown>;
    expect(invite).toMatchObject({ personName: 'Mika', invite: true, expiresAt: clock + INVITE_TTL_MS });
    expect(invite.expiresAt).toBe(clock + 3 * 24 * 60 * MINUTE);
    expect(registrar.registerCode).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), clock + INVITE_TTL_MS);
    const mika = auth.people().find((p) => p.name === 'Mika')!;
    expect(invite.personId).toBe(mika.id);

    const { codes } = (await (await send('GET', '/api/admin/codes', owner)).json()) as { codes: Record<string, unknown>[] };
    expect(codes).toEqual([
      { id: expect.any(String), personId: ownerPerson.id, personName: 'Owner', invite: false, expiresAt: clock + 10 * MINUTE },
      { id: expect.any(String), personId: mika.id, personName: 'Mika', invite: true, expiresAt: clock + INVITE_TTL_MS },
    ]);
  });

  it('unregisters a code from the rendezvous when it is spent, deleted, or goes with its person', async () => {
    const owner = await ownerToken();
    // the owner's own pairing spent a code
    expect(registrar.unregisterCode).toHaveBeenCalledTimes(1);

    const mint = async (body: unknown): Promise<{ code: string }> => (await (await send('POST', '/api/admin/codes', owner, body)).json()) as { code: string };
    const spent = await mint({ newPerson: { name: 'Mika', owner: false } });
    await redeem(spent.code, 'Phone');
    expect(registrar.unregisterCode).toHaveBeenLastCalledWith(codeHash(spent.code));

    const withdrawn = await mint({ newPerson: { name: 'Den', owner: false }, invite: true });
    const { codes } = (await (await send('GET', '/api/admin/codes', owner)).json()) as { codes: { id: string }[] };
    expect((await send('DELETE', `/api/admin/codes/${codes[0]!.id}`, owner)).status).toBe(204);
    expect(registrar.unregisterCode).toHaveBeenLastCalledWith(codeHash(withdrawn.code));

    const sora = await mint({ newPerson: { name: 'Sora', owner: false }, invite: true });
    const soraId = auth.people().find((p) => p.name === 'Sora')!.id;
    expect((await send('DELETE', `/api/admin/people/${soraId}`, owner)).status).toBe(204);
    expect(registrar.unregisterCode).toHaveBeenLastCalledWith(codeHash(sora.code));
    expect(registrar.unregisterCode).toHaveBeenCalledTimes(4);
  });

  it('logs a failed unregistration and still answers', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    registrar.unregisterCode.mockRejectedValue(new Error('down'));
    const owner = await ownerToken();
    const { code } = (await (await send('POST', '/api/admin/codes', owner, { newPerson: { name: 'Mika', owner: false } })).json()) as { code: string };
    await redeem(code, 'Phone');
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('rendezvous unregistration failed', expect.objectContaining({ message: 'down' })));
    errors.mockRestore();
  });

  it('refuses a bad body or an unknown person', async () => {
    const owner = await ownerToken();
    expect((await send('POST', '/api/admin/codes', owner, { personId: 'nope' })).status).toBe(404);
    for (const body of [
      {},
      { owner: true },
      { personId: 1 },
      { personId: 'x', newPerson: { name: 'Mika', owner: false } },
      { newPerson: { name: 'Mika' } },
      { newPerson: { name: '', owner: false } },
      { personId: auth.firstOwnerPerson().id, invite: 'yes' },
    ]) {
      expect((await send('POST', '/api/admin/codes', owner, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("pairs a device to the code's person, and redeem names it", async () => {
    const owner = await ownerToken();
    const { code } = (await (await send('POST', '/api/admin/codes', owner, { newPerson: { name: 'Mika', owner: false } })).json()) as { code: string };
    const { redeemed } = await redeem(code, 'Phone');
    const mika = auth.people().find((p) => p.name === 'Mika')!;
    expect(redeemed).toEqual({ deviceId: expect.any(String), owner: false, personId: mika.id, personName: 'Mika' });
  });

  it('prunes people made for codes that were never used, once the codes are gone', async () => {
    const owner = await ownerToken();
    await send('POST', '/api/admin/codes', owner, { newPerson: { name: 'Mika', owner: false } });
    await send('POST', '/api/admin/codes', owner, { newPerson: { name: 'Den', owner: false }, invite: true });
    const kept = auth.createPerson('Sora', false);
    const names = async (): Promise<string[]> =>
      ((await (await send('GET', '/api/admin/people', owner)).json()) as { people: PersonView[] }).people.map((p) => p.name);
    expect(await names()).toEqual(['Owner', 'Mika', 'Den', 'Sora']);
    clock += 10 * MINUTE;
    expect(await names()).toEqual(['Owner', 'Den', 'Sora']);
    clock += INVITE_TTL_MS;
    // the session has expired too: pair the owner again
    const later = await ownerToken();
    const { codes } = (await (await send('GET', '/api/admin/codes', later)).json()) as { codes: unknown[] };
    expect(codes).toEqual([]);
    expect(auth.people().map((p) => p.name)).toEqual(['Owner', 'Sora']);
    expect(kept.id).toBe(auth.people()[1]!.id);
  });
});
