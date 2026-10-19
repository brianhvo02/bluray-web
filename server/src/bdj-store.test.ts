import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BdjStore, parseScope, StoreError } from './bdj-store.js';
import { EMPTY_TAR, writeTar } from './tar.js';

const ORG = '0a1b2c3d';
const DISC = 'f'.repeat(32);
const P = 'mika_person-1';
const archive = (text: string): Buffer => writeTar([{ path: 'slot0', data: Buffer.from(text), mtime: 1 }]);
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof StoreError ? err.code : `other:${String(err)}`;
  }
  return undefined;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bdj-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseScope', () => {
  it('accepts the two scope shapes', () => {
    expect(parseScope(`persistent/${ORG}`)).toBe(`persistent/${ORG}`);
    expect(parseScope(`buda/${ORG}/${DISC}`)).toBe(`buda/${ORG}/${DISC}`);
  });
  it.each([
    'persistent/0A1B2C3D',
    'persistent/0a1b2c3',
    `buda/${ORG}`,
    `persistent/${ORG}/x`,
    '../',
    `buda/${ORG}/${'F'.repeat(32)}`,
    `persistent/${ORG}/../x`,
  ])('rejects %s', (raw) => expect(parseScope(raw)).toBeNull());
});

describe('BdjStore', () => {
  const scope = `persistent/${ORG}`;

  it('starts empty', () => {
    expect(new BdjStore(dir).get(P, scope)).toEqual({ etag: null, body: EMPTY_TAR });
  });

  it('puts with If-None-Match and reads it back', () => {
    const store = new BdjStore(dir);
    const body = archive('one');
    const { etag } = store.put(P, scope, body, { ifNoneMatch: true });
    expect(store.get(P, scope)).toEqual({ etag, body });
    expect(code(() => store.put(P, scope, body, { ifNoneMatch: true }))).toBe('precondition');
  });

  it('handles buda scopes in their own folder', () => {
    const store = new BdjStore(dir);
    store.put(P, `buda/${ORG}/${DISC}`, archive('x'), { ifNoneMatch: true });
    expect(existsSync(join(dir, 'users', P, 'bdj', 'buda', ORG, `${DISC}.tar`))).toBe(true);
  });

  it('replaces under a matching etag and refuses a stale or missing one', () => {
    const store = new BdjStore(dir);
    const first = store.put(P, scope, archive('one'), { ifNoneMatch: true });
    const second = store.put(P, scope, archive('two'), { ifMatch: first.etag });
    expect(second.etag).not.toBe(first.etag);
    expect(code(() => store.put(P, scope, archive('three'), { ifMatch: first.etag }))).toBe('precondition');
    expect(code(() => store.put(P, scope, archive('three'), {}))).toBe('precondition');
    expect(code(() => store.put(P, `persistent/11111111`, archive('x'), { ifMatch: first.etag }))).toBe('precondition');
  });

  it('never repeats an etag across quick same-size replaces', () => {
    const store = new BdjStore(dir);
    const a = store.put(P, scope, archive('aaa'), { ifNoneMatch: true }).etag;
    const b = store.put(P, scope, archive('bbb'), { ifMatch: a }).etag;
    const c = store.put(P, scope, archive('ccc'), { ifMatch: b }).etag;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('fails a put when the scope lock stays held', () => {
    const store = new BdjStore(dir);
    store.put(P, scope, archive('one'), { ifNoneMatch: true });
    writeFileSync(join(dir, 'users', P, 'bdj', 'persistent', `${ORG}.tar.lock`), '');
    expect(code(() => store.put(P, scope, archive('two'), { ifNoneMatch: true }))).toMatch(/^other:.*is held/);
  }, 15_000);

  it('sweeps old temp files beside the scope on put, and keeps fresh ones', () => {
    const store = new BdjStore(dir);
    const { etag } = store.put(P, scope, archive('one'), { ifNoneMatch: true });
    const folder = join(dir, 'users', P, 'bdj', 'persistent');
    const old = join(folder, `${ORG}.tar.1.old.tmp`);
    const fresh = join(folder, `${ORG}.tar.2.new.tmp`);
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const longAgo = (Date.now() - 2 * 60 * 60_000) / 1000;
    utimesSync(old, longAgo, longAgo);
    store.put(P, scope, archive('two'), { ifMatch: etag });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('lets exactly one of two writers with the same If-Match win', async () => {
    const store = new BdjStore(dir);
    const { etag } = store.put(P, scope, archive('base'), { ifNoneMatch: true });
    const attempt = async (text: string): Promise<string> =>
      code(() => store.put(P, scope, archive(text), { ifMatch: etag })) ?? 'ok';
    const results = await Promise.all([attempt('a'), attempt('b')]);
    expect(results.sort()).toEqual(['ok', 'precondition']);
  });

  it('deletes only under a matching etag', () => {
    const store = new BdjStore(dir);
    const { etag } = store.put(P, scope, archive('one'), { ifNoneMatch: true });
    expect(code(() => store.delete(P, scope, 'nope'))).toBe('precondition');
    store.delete(P, scope, etag);
    expect(store.get(P, scope).etag).toBeNull();
    expect(code(() => store.delete(P, scope, etag))).toBe('precondition');
  });

  it('enforces the scope quota', () => {
    const store = new BdjStore(dir);
    expect(code(() => store.put(P, scope, Buffer.alloc(16 * 1024 * 1024 + 1), { ifNoneMatch: true }))).toBe('quota-scope');
  });

  it('enforces the person quota across scopes, counting a replaced scope once', () => {
    const store = new BdjStore(dir, { scopeLimit: 4096, personLimit: 16384 });
    // A valid archive padded with zero blocks to exactly 4096 bytes.
    const head = writeTar([{ path: 'x', data: Buffer.alloc(2048), mtime: 0 }]).subarray(0, 512 + 2048);
    const full = Buffer.concat([head, Buffer.alloc(4096 - head.length)]);
    const scopes = Array.from({ length: 4 }, (_, i) => `persistent/0000000${i}`);
    const etags = scopes.map((s) => store.put(P, s, full, { ifNoneMatch: true }).etag);
    expect(store.usage(P)).toBe(16384);
    expect(code(() => store.put(P, 'persistent/00000009', EMPTY_TAR, { ifNoneMatch: true }))).toBe('quota-person');
    // Replacing a scope with an equally large archive still fits.
    expect(code(() => store.put(P, scopes[0]!, full, { ifMatch: etags[0]! }))).toBeUndefined();
    expect(store.usage(P)).toBe(16384);
    // Another person has their own allowance.
    expect(code(() => store.put('Other', scopes[0]!, full, { ifNoneMatch: true }))).toBeUndefined();
  });

  it('rejects a bad archive and writes nothing', () => {
    const store = new BdjStore(dir);
    expect(code(() => store.put(P, scope, Buffer.from('not a tar'), { ifNoneMatch: true }))).toBe('bad-archive');
    expect(existsSync(join(dir, 'users', P, 'bdj', 'persistent', `${ORG}.tar`))).toBe(false);
    expect(store.usage(P)).toBe(0);
  });

  it('ignores a temp file left by a crash', () => {
    const store = new BdjStore(dir);
    const { etag } = store.put(P, scope, archive('one'), { ifNoneMatch: true });
    const folder = join(dir, 'users', P, 'bdj', 'persistent');
    writeFileSync(join(folder, `${ORG}.tar.123.abc.tmp`), 'half a write');
    expect(store.get(P, scope).etag).toBe(etag);
    expect(store.usage(P)).toBe(archive('one').length);
    expect(readdirSync(folder).some((n) => n.endsWith('.tmp'))).toBe(true);
  });

  it('sums usage and clears a person', () => {
    const store = new BdjStore(dir);
    const a = archive('aaa');
    const b = archive('bbbbbbbb');
    store.put(P, scope, a, { ifNoneMatch: true });
    store.put(P, `buda/${ORG}/${DISC}`, b, { ifNoneMatch: true });
    expect(store.usage(P)).toBe(a.length + b.length);
    expect(store.usage('someone-else')).toBe(0);
    mkdirSync(join(dir, 'users', 'other'), { recursive: true });
    store.clear(P);
    expect(existsSync(join(dir, 'users', P))).toBe(false);
    expect(existsSync(join(dir, 'users', 'other'))).toBe(true);
    expect(store.usage(P)).toBe(0);
  });

  it('refuses ids and scopes that could leave the data folder', () => {
    const store = new BdjStore(dir);
    expect(() => store.get('../x', scope)).toThrow();
    expect(() => store.get(P, '../../x')).toThrow();
    expect(() => store.clear('')).toThrow();
  });
});
