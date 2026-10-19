import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
