import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('tells a direct choice from a copy that follows its source', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('anilist:1'));
    s.reattach([{ id: 'A', fingerprint: 'F' }, { id: 'B', fingerprint: 'F' }]);
    expect(s.choiceOrigin('A')).toEqual({ direct: true });
    expect(s.choiceOrigin('B')).toEqual({ direct: false, source: 'A' });
    expect(s.choiceOrigin('C')).toBeNull();
  });

  it('gives a choice to every present disc with the fingerprint and no choice, keeping the original', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('anilist:1'));
    s.reattach([{ id: 'B', fingerprint: 'F' }, { id: 'C', fingerprint: 'F' }, { id: 'D', fingerprint: 'G' }]);
    const { choices } = s.snapshot();
    expect(choices.get('A')).toEqual(title('anilist:1'));
    expect(choices.get('B')).toEqual(title('anilist:1'));
    expect(choices.get('C')).toEqual(title('anilist:1'));
    expect(choices.has('D')).toBe(false);
  });

  it('gives a present copy its present twin\'s choice, and never overwrites a disc\'s own choice', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('t1'));
    s.setChoice('B', 'F', { kind: 'hidden' });
    s.reattach([{ id: 'A', fingerprint: 'F' }, { id: 'B', fingerprint: 'F' }, { id: 'C', fingerprint: 'F' }]);
    const { choices } = s.snapshot();
    expect(choices.get('A')).toEqual(title('t1'));
    expect(choices.get('B')).toEqual({ kind: 'hidden' });
    expect(choices.get('C')).toEqual({ kind: 'hidden' });
  });

  it('propagates the most recently set choice when absent copies disagree', () => {
    const s = new OwnerStore(dir);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    s.setChoice('A', 'F', title('old'));
    now.mockReturnValue(2000);
    s.setChoice('B', 'F', title('new'));
    now.mockRestore();
    s.reattach([{ id: 'C', fingerprint: 'F' }]);
    expect(s.snapshot().choices.get('C')).toEqual(title('new'));
    expect(s.snapshot().choices.get('A')).toEqual(title('old'));
  });

  it('updates a propagated copy when the source is re-filed', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('t1'));
    s.reattach([{ id: 'A', fingerprint: 'F' }, { id: 'B', fingerprint: 'F' }]);
    s.setChoice('A', 'F', title('t2'));
    s.reattach([{ id: 'A', fingerprint: 'F' }, { id: 'B', fingerprint: 'F' }]);
    expect(s.snapshot().choices.get('B')).toEqual(title('t2'));
  });

  it('keeps the choice of a copy filed directly', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('t1'));
    s.reattach([{ id: 'A', fingerprint: 'F' }, { id: 'B', fingerprint: 'F' }]);
    s.setChoice('B', 'F', title('mine'));
    s.setChoice('A', 'F', title('t3'));
    s.reattach([{ id: 'A', fingerprint: 'F' }, { id: 'B', fingerprint: 'F' }]);
    expect(s.snapshot().choices.get('B')).toEqual(title('mine'));
  });

  it('clears the propagated copies when the source choice is cleared', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('t1'));
    s.reattach([{ id: 'A', fingerprint: 'F' }, { id: 'B', fingerprint: 'F' }]);
    s.clearChoice('A');
    s.reattach([{ id: 'A', fingerprint: 'F' }, { id: 'B', fingerprint: 'F' }]);
    expect(s.snapshot().choices.size).toBe(0);
  });

  it('stores a fingerprint that became known or changed on a present disc', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', null, title('t'));
    s.reattach([{ id: 'A', fingerprint: 'F' }]);
    s.reattach([{ id: 'B', fingerprint: 'F' }]);
    expect(s.snapshot().choices.get('B')).toEqual(title('t'));
    s.reattach([{ id: 'A', fingerprint: 'G' }]);
    s.reattach([{ id: 'E', fingerprint: 'G' }]);
    expect(s.snapshot().choices.get('E')).toEqual(title('t'));
  });

  it('writes owner.json only when reattach changed something', () => {
    const s = new OwnerStore(dir);
    s.setChoice('A', 'F', title('t'));
    const file = join(dir, 'owner.json');
    const old = new Date(2000, 0, 1);
    utimesSync(file, old, old);
    s.reattach([{ id: 'A', fingerprint: 'F' }]);
    expect(statSync(file).mtimeMs).toBe(old.getTime());
    s.reattach([{ id: 'B', fingerprint: 'F' }]);
    expect(statSync(file).mtimeMs).not.toBe(old.getTime());
  });

  it('loses no update when two stores on one dir change it in turn', () => {
    const a = new OwnerStore(dir);
    const b = new OwnerStore(dir);
    for (let i = 0; i < 20; i++) {
      a.setChoice(`a${i}`, null, { kind: 'hidden' });
      b.setChoice(`b${i}`, null, { kind: 'hidden' });
    }
    expect(a.snapshot().choices.size).toBe(40);
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
    for (const body of [
      '{"choices":[],"ownTitles":[],"displayNames":{},"gate":null}',
      '{"choices":{"A":5},"ownTitles":[],"displayNames":{},"gate":null}',
      '{"choices":{"A":{"choice":{"kind":"title"},"fingerprint":null,"setAt":1,"propagated":false}},"ownTitles":[],"displayNames":{},"gate":null}',
      '{"choices":{},"ownTitles":[{"id":"own:1","kind":"show","name":"x","seasons":null}],"displayNames":{},"gate":null}',
      '{"choices":{},"ownTitles":[],"displayNames":{"A":3},"gate":null}',
      '{"choices":{"A":{"choice":{"kind":"hidden"},"fingerprint":null,"setAt":1}},"ownTitles":[],"displayNames":{},"gate":null}',
    ]) {
      writeFileSync(join(dir, 'owner.json'), body);
      expect(() => new OwnerStore(dir).snapshot()).toThrow(/owner\.json is corrupt/);
    }
  });
});
