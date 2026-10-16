import { STORES, withStore as withDbStore } from './db';

const MAX_RECENT = 5;

const withStore = <T>(factory: IDBFactory, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void) =>
  withDbStore<T>(factory, STORES.recentDiscs, mode, run);

export interface RecentDisc {
  readonly id: number;
  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;
  readonly openedAt: number;
}

/** Whether two handles point at the same folder (injectable because test doubles can't carry methods through IndexedDB). */
export type SameFolder = (a: FileSystemDirectoryHandle, b: FileSystemDirectoryHandle) => Promise<boolean>;

const isSameFolder: SameFolder = (a, b) => a.isSameEntry(b);

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
