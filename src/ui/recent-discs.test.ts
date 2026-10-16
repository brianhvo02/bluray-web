import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { listRecentDiscs, removeRecentDisc, reopenRecentDisc, saveRecentDisc, type RecentDisc } from './recent-discs';

// Plain objects survive IndexedDB's structured clone; `path` stands in for the folder's identity.
const handle = (name: string, path = name): FileSystemDirectoryHandle =>
  ({ kind: 'directory', name, path }) as unknown as FileSystemDirectoryHandle;
const samePath = async (a: FileSystemDirectoryHandle, b: FileSystemDirectoryHandle): Promise<boolean> =>
  (a as unknown as { path: string }).path === (b as unknown as { path: string }).path;

describe('recent discs', () => {
  it('keeps the five most recent, newest first, moving a reopened disc to the front', async () => {
    const factory = new IDBFactory();
    for (let i = 0; i < 7; i++) await saveRecentDisc(handle(`Disc ${i}`), 1000 + i, factory, samePath);
    await saveRecentDisc(handle('Disc 2'), 2000, factory, samePath);
    expect((await listRecentDiscs(factory)).map((d) => d.name)).toEqual(['Disc 2', 'Disc 6', 'Disc 5', 'Disc 4', 'Disc 3']);
  });

  it('keeps two different discs that were both opened through a folder named BDMV', async () => {
    const factory = new IDBFactory();
    await saveRecentDisc(handle('BDMV', '/Movies/A/BDMV'), 1, factory, samePath);
    await saveRecentDisc(handle('BDMV', '/Movies/B/BDMV'), 2, factory, samePath);
    await saveRecentDisc(handle('BDMV', '/Movies/A/BDMV'), 3, factory, samePath);
    const paths = (await listRecentDiscs(factory)).map((d) => (d.handle as unknown as { path: string }).path);
    expect(paths).toEqual(['/Movies/A/BDMV', '/Movies/B/BDMV']);
  });

  it('removes a disc by id', async () => {
    const factory = new IDBFactory();
    await saveRecentDisc(handle('A'), 1, factory, samePath);
    const [disc] = await listRecentDiscs(factory);
    await removeRecentDisc(disc.id, factory);
    expect(await listRecentDiscs(factory)).toEqual([]);
  });

  it('treats a permission request that throws (folder moved or deleted) as not granted', async () => {
    const disc = {
      id: 1,
      name: 'A',
      openedAt: 0,
      handle: { queryPermission: async () => 'prompt', requestPermission: async () => Promise.reject(new DOMException('gone', 'NotFoundError')) },
    } as unknown as RecentDisc;
    await expect(reopenRecentDisc(disc)).resolves.toBeNull();
  });

  it('upgrades a version 2 database to 3, keeping its recent discs', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('bluray-web', 2);
      req.onupgradeneeded = () => req.result.createObjectStore('recent-discs-v2', { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => {
        const tx = req.result.transaction('recent-discs-v2', 'readwrite');
        tx.objectStore('recent-discs-v2').put({ name: 'Old', handle: { kind: 'directory', name: 'Old' }, openedAt: 5 });
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    expect((await listRecentDiscs(factory)).map((d) => d.name)).toEqual(['Old']);
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = factory.open('bluray-web');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    expect(db.version).toBe(3);
    expect([...db.objectStoreNames].sort()).toEqual(['recent-discs-v2', 'settings', 'shader-files', 'shader-sets']);
    db.close();
  });
});
