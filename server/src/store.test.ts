import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Auth } from './auth';
import { Store } from './store';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'store-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
const device = (id: string, name: string, owner: boolean) => ({ id, name, owner, publicKeyJwk: jwk, pairedAt: 1, lastSeen: 2 });
const code = (id: string, owner: boolean, expiresAt: number) => ({ id, hash: `h${id}`, owner, expiresAt });
const LIVE = Date.now() + 60 * 60_000;

describe('Store migration', () => {
  it('migrates a step-2 file once', () => {
    writeFileSync(
      join(tmp, 'auth.json'),
      JSON.stringify({
        devices: [device('d1', 'Mac', true), device('d2', 'Laptop', true), device('d3', 'Den TV', false)],
        codes: [code('c1', true, LIVE), code('c2', false, LIVE), code('c3', true, 1)],
      }),
    );
    const data = new Store(tmp).read();
    expect(data.people.map(({ name, owner }) => ({ name, owner }))).toEqual([
      { name: 'Owner', owner: true },
      { name: 'Den TV', owner: false },
    ]);
    const [owner, den] = data.people;
    expect(data.devices.map((d) => [d.id, d.personId])).toEqual([
      ['d1', owner!.id],
      ['d2', owner!.id],
      ['d3', den!.id],
    ]);
    expect(data.devices.some((d) => 'owner' in d)).toBe(false);
    expect(data.codes).toEqual([{ id: 'c1', hash: 'hc1', personId: owner!.id, invite: false, expiresAt: LIVE }]);

    const onDisk = JSON.parse(readFileSync(join(tmp, 'auth.json'), 'utf8')) as { people: { id: string }[] };
    expect(onDisk.people.map((p) => p.id)).toEqual([owner!.id, den!.id]);

    expect(new Store(tmp).read()).toEqual(data);
  });

  it('rejects a migrated file whose device names an unknown person', () => {
    writeFileSync(
      join(tmp, 'auth.json'),
      JSON.stringify({ people: [], devices: [{ id: 'd1', name: 'Mac', personId: 'nobody', publicKeyJwk: jwk, pairedAt: 1, lastSeen: 2 }], codes: [] }),
    );
    expect(() => new Store(tmp).read()).toThrow(/is corrupt/);
  });

  it('rejects a code whose person is unknown', () => {
    const owner = { id: 'p1', name: 'Owner', owner: true, createdAt: 1 };
    writeFileSync(join(tmp, 'auth.json'), JSON.stringify({ people: [owner], devices: [], codes: [{ id: 'c', hash: 'h', personId: 'nobody', invite: false, expiresAt: LIVE }] }));
    expect(() => new Store(tmp).read()).toThrow(/codes\[0\]\.personId names an unknown person/);
  });

  it('makes Owner for a live owner code when no owner device exists', () => {
    writeFileSync(join(tmp, 'auth.json'), JSON.stringify({ devices: [device('d3', 'Den TV', false)], codes: [code('c1', true, LIVE)] }));
    const data = new Store(tmp).read();
    expect(data.people.map((p) => p.name)).toEqual(['Owner', 'Den TV']);
    expect(data.codes[0]!.personId).toBe(data.people[0]!.id);
  });

  it('rejects a step-2 device whose owner is not a boolean', () => {
    writeFileSync(join(tmp, 'auth.json'), JSON.stringify({ devices: [{ ...device('d1', 'Mac', true), owner: 'yes' }], codes: [] }));
    expect(() => new Store(tmp).read()).toThrow(/devices\[0\]\.owner is not a boolean/);
  });

  it('migrates to the same ids every time', () => {
    const text = JSON.stringify({ devices: [device('d1', 'Mac', true), device('d3', 'Den TV', false)], codes: [] });
    writeFileSync(join(tmp, 'auth.json'), text);
    const first = new Store(tmp).read().people.map((p) => p.id);
    writeFileSync(join(tmp, 'auth.json'), text);
    expect(new Store(tmp).read().people.map((p) => p.id)).toEqual(first);
  });

  // Not swallowed: a lock held during construction stops the start, instead of leaving read() and update() to migrate separately.
  it('throws from the constructor when the lock is held, rather than half-migrating', () => {
    writeFileSync(join(tmp, 'auth.json'), JSON.stringify({ devices: [device('d1', 'Mac', true)], codes: [] }));
    closeSync(openSync(join(tmp, 'auth.json.lock'), 'wx'));
    expect(() => new Store(tmp)).toThrow(/is held/);
    rmSync(join(tmp, 'auth.json.lock'));
    const auth = new Auth(new Store(tmp), () => Date.now());
    expect(() => auth.createCode({ personId: auth.firstOwnerPerson().id })).not.toThrow();
  }, 15_000);
});
