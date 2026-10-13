const DB_NAME = 'bluray-web';
const DB_VERSION = 2;
/** v1 keyed discs by folder name, so two discs opened via folders named "BDMV" overwrote each other. */
const LEGACY_STORE = 'recent-discs';
const STORE = 'recent-discs-v2';
const MAX_RECENT = 5;

export interface RecentDisc {
  readonly id: number;
  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;
  readonly openedAt: number;
}

/** Whether two handles point at the same folder (injectable because test doubles can't carry methods through IndexedDB). */
export type SameFolder = (a: FileSystemDirectoryHandle, b: FileSystemDirectoryHandle) => Promise<boolean>;

const isSameFolder: SameFolder = (a, b) => a.isSameEntry(b);

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(LEGACY_STORE)) db.deleteObjectStore(LEGACY_STORE);
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
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
      tx.onabort = () => reject(tx.error ?? new DOMException('Recent-discs transaction aborted', 'AbortError'));
    });
  } finally {
    db.close();
  }
}

export async function listRecentDiscs(factory: IDBFactory = indexedDB): Promise<RecentDisc[]> {
  const all = (await withStore<RecentDisc[]>(factory, 'readonly', (store) => store.getAll() as IDBRequest<RecentDisc[]>)) ?? [];
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

export async function saveRecentDisc(
  handle: FileSystemDirectoryHandle,
  now = Date.now(),
  factory: IDBFactory = indexedDB,
  sameFolder: SameFolder = isSameFolder,
): Promise<void> {
  let match: RecentDisc | undefined;
  for (const disc of await listRecentDiscs(factory)) {
    if (await sameFolder(disc.handle, handle).catch(() => false)) {
      match = disc;
      break;
    }
  }
  await withStore(factory, 'readwrite', (store) => {
    store.put(match ? { ...match, name: handle.name, handle, openedAt: now } : { name: handle.name, handle, openedAt: now });
  });
  const stale = (await listRecentDiscs(factory)).slice(MAX_RECENT);
  for (const disc of stale) await removeRecentDisc(disc.id, factory);
}

export async function removeRecentDisc(id: number, factory: IDBFactory = indexedDB): Promise<void> {
  await withStore(factory, 'readwrite', (store) => {
    store.delete(id);
  });
}

/** Returns the handle if read permission is (or becomes) granted; null if refused or the folder is gone. Call from a click handler. */
export async function reopenRecentDisc(disc: RecentDisc): Promise<FileSystemDirectoryHandle | null> {
  const descriptor = { mode: 'read' as const };
  try {
    if ((await disc.handle.queryPermission?.(descriptor)) === 'granted') return disc.handle;
    return (await disc.handle.requestPermission?.(descriptor)) === 'granted' ? disc.handle : null;
  } catch {
    return null; // the folder was moved or deleted since it was saved
  }
}
