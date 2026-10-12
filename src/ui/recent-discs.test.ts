import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { listRecentDiscs, removeRecentDisc, saveRecentDisc } from './recent-discs';

const handle = (name: string): FileSystemDirectoryHandle => ({ kind: 'directory', name }) as unknown as FileSystemDirectoryHandle;

describe('recent discs', () => {
  it('keeps the five most recent, newest first', async () => {
    const factory = new IDBFactory();
    for (let i = 0; i < 7; i++) await saveRecentDisc(handle(`Disc ${i}`), 1000 + i, factory);
    await saveRecentDisc(handle('Disc 2'), 2000, factory);
    expect((await listRecentDiscs(factory)).map((d) => d.name)).toEqual(['Disc 2', 'Disc 6', 'Disc 5', 'Disc 4', 'Disc 3']);
  });

  it('removes a disc', async () => {
    const factory = new IDBFactory();
    await saveRecentDisc(handle('A'), 1, factory);
    await removeRecentDisc('A', factory);
    expect(await listRecentDiscs(factory)).toEqual([]);
  });
});
