import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { idbShaderLibrary } from './shader-library';

describe('idb shader library', () => {
  it('puts, lists and removes files; re-putting a name replaces its source', async () => {
    const lib = idbShaderLibrary(new IDBFactory());
    await lib.putFiles([{ name: 'a.glsl', source: 'one', addedAt: 1 }, { name: 'b.glsl', source: 'two', addedAt: 2 }]);
    await lib.putFiles([{ name: 'a.glsl', source: 'three', addedAt: 3 }]);
    const files = (await lib.files()).sort((x, y) => x.name.localeCompare(y.name));
    expect(files).toEqual([{ name: 'a.glsl', source: 'three', addedAt: 3 }, { name: 'b.glsl', source: 'two', addedAt: 2 }]);
    await lib.removeFile('a.glsl');
    expect((await lib.files()).map((f) => f.name)).toEqual(['b.glsl']);
  });

  it('replaces imported sets of the same name and removes by name', async () => {
    const lib = idbShaderLibrary(new IDBFactory());
    await lib.putImportedSets([{ name: 'X', files: ['a.glsl'], origin: 'imported' }, { name: 'Y', files: ['b.glsl'], origin: 'imported' }]);
    await lib.putImportedSets([{ name: 'X', files: ['c.glsl'], origin: 'imported' }]);
    const sets = (await lib.importedSets()).sort((a, b) => a.name.localeCompare(b.name));
    expect(sets).toEqual([{ name: 'X', files: ['c.glsl'], origin: 'imported' }, { name: 'Y', files: ['b.glsl'], origin: 'imported' }]);
    await lib.removeImportedSet('X');
    expect((await lib.importedSets()).map((s) => s.name)).toEqual(['Y']);
  });

  it('round-trips the selection', async () => {
    const lib = idbShaderLibrary(new IDBFactory());
    expect(await lib.selected()).toBeNull();
    await lib.setSelected('Anime4K: Mode A (Fast)');
    expect(await lib.selected()).toBe('Anime4K: Mode A (Fast)');
    await lib.setSelected(null);
    expect(await lib.selected()).toBeNull();
  });
});
