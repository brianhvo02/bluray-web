const DB_NAME = 'bluray-web';
const STORE = 'recent-discs';
const MAX_RECENT = 5;

export interface RecentDisc {
  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;
  readonly openedAt: number;
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(factory: IDBFactory, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb(factory);
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listRecentDiscs(factory: IDBFactory = indexedDB): Promise<RecentDisc[]> {
  const all = (await withStore<RecentDisc[]>(factory, 'readonly', (store) => store.getAll() as IDBRequest<RecentDisc[]>)) ?? [];
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

export async function saveRecentDisc(handle: FileSystemDirectoryHandle, now = Date.now(), factory: IDBFactory = indexedDB): Promise<void> {
  await withStore(factory, 'readwrite', (store) => {
    store.put({ name: handle.name, handle, openedAt: now });
  });
  const stale = (await listRecentDiscs(factory)).slice(MAX_RECENT);
  for (const disc of stale) await removeRecentDisc(disc.name, factory);
}

export async function removeRecentDisc(name: string, factory: IDBFactory = indexedDB): Promise<void> {
  await withStore(factory, 'readwrite', (store) => {
    store.delete(name);
  });
}

/** Returns the handle if read permission is (or becomes) granted. Call from a click handler. */
export async function reopenRecentDisc(disc: RecentDisc): Promise<FileSystemDirectoryHandle | null> {
  const descriptor = { mode: 'read' as const };
  if ((await disc.handle.queryPermission?.(descriptor)) === 'granted') return disc.handle;
  return (await disc.handle.requestPermission?.(descriptor)) === 'granted' ? disc.handle : null;
}
