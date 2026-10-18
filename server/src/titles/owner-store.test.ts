import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerChoice } from '../../../src/engine/disc/nas-api';
import { OwnerStore } from './owner-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const title = (titleId: string): OwnerChoice => ({ kind: 'title', titleId, season: 1, disc: 2 });

describe('OwnerStore', () => {
  it('keeps a choice across a new store on the same dir', () => {
    new OwnerStore(dir).setChoice('A', 'F', title('anilist:1'));
    expect(new OwnerStore(dir).snapshot().choices.get('A')).toEqual(title('anilist:1'));
  });

  it('moves a choice to every present disc with the same fingerprint', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('anilist:1'));
    s.reattach([{ id: 'B', fingerprint: 'F' }, { id: 'C', fingerprint: 'F' }, { id: 'D', fingerprint: 'G' }]);
    const { choices } = s.snapshot();
    expect(choices.has('A')).toBe(false);
    expect(choices.get('B')).toEqual(title('anilist:1'));
    expect(choices.get('C')).toEqual(title('anilist:1'));
    expect(choices.has('D')).toBe(false);
  });

  it('keeps a choice while its disc is present, and one with no fingerprint while its disc is absent', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('t'));
    s.setChoice('N', null, { kind: 'hidden' });
    s.reattach([{ id: 'A', fingerprint: 'F' }, { id: 'B', fingerprint: 'F' }, { id: 'M', fingerprint: null }]);
    const { choices } = s.snapshot();
    expect(choices.has('A')).toBe(true);
    expect(choices.has('B')).toBe(false);
    expect(choices.get('N')).toEqual({ kind: 'hidden' });
    expect(choices.has('M')).toBe(false);
  });

  it('keeps a choice when no present disc carries its fingerprint', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('t'));
    s.reattach([{ id: 'B', fingerprint: 'G' }]);
    expect(s.snapshot().choices.has('A')).toBe(true);
  });

  it('deleteTitle removes the title and the choices naming it', () => {
    const s = new OwnerStore(dir);
    const own = s.createTitle('series', 'Made Up', 2);
    expect(own.id).toMatch(/^own:/);
    s.setChoice('A', null, title(own.id));
    s.setChoice('B', null, { kind: 'extras', titleId: own.id, season: null });
    s.setChoice('C', null, title('anilist:1'));
    s.deleteTitle(own.id);
    const snap = s.snapshot();
    expect([...snap.choices.keys()]).toEqual(['C']);
    expect(snap.ownTitles).toEqual([]);
  });

  it('updates an own title and rejects an unknown one', () => {
    const s = new OwnerStore(dir);
    const own = s.createTitle('movie', 'Made Up', null);
    expect(s.updateTitle(own.id, { name: 'Renamed', seasons: 3 })).toEqual({ ...own, name: 'Renamed', seasons: 3 });
    expect(() => s.updateTitle('own:nope', { name: 'x' })).toThrow(/own:nope/);
  });

  it('sets and clears display names', () => {
    const s = new OwnerStore(dir);
    s.setDisplayName('A', 'Disc one');
    expect(s.snapshot().displayNames.get('A')).toBe('Disc one');
    s.setDisplayName('A', null);
    expect(s.snapshot().displayNames.size).toBe(0);
  });

  it('persists the gate, null until set', () => {
    const s = new OwnerStore(dir);
    expect(s.snapshot().gate).toBeNull();
    s.setGate('everyone');
    expect(new OwnerStore(dir).snapshot().gate).toBe('everyone');
  });

  it('throws an error naming owner.json when it is corrupt', () => {
    writeFileSync(join(dir, 'owner.json'), '{nope');
    expect(() => new OwnerStore(dir).snapshot()).toThrow(/owner\.json is corrupt/);
    writeFileSync(join(dir, 'owner.json'), '{"choices":[],"ownTitles":[],"displayNames":{},"gate":null}');
    expect(() => new OwnerStore(dir).snapshot()).toThrow(/owner\.json is corrupt/);
  });
});
