import { STORES, withStore } from '../db';

/** This device's pairing with a NAS. `key` is stored as the CryptoKeyPair itself; its private key is non-extractable. */
export interface NasPairing {
  /** The NAS API base, ending in '/', e.g. 'https://mediaserver.tailnet-8e55.ts.net/bluray/api/'. */
  readonly base: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly owner: boolean;
  readonly key: CryptoKeyPair;
}

export interface NasStore {
  get(): Promise<NasPairing | null>;
  put(pairing: NasPairing): Promise<void>;
  clear(): Promise<void>;
}

const KEY = 'pairing';

/** The pairing in IndexedDB. */
export function idbNasStore(factory: IDBFactory = indexedDB): NasStore {
  return {
    async get() {
      return (await withStore<NasPairing | undefined>(factory, STORES.nas, 'readonly', (s) => s.get(KEY) as IDBRequest<NasPairing | undefined>)) ?? null;
    },
    async put(pairing) {
      await withStore(factory, STORES.nas, 'readwrite', (s) => {
        s.put(pairing, KEY);
      });
    },
    async clear() {
      await withStore(factory, STORES.nas, 'readwrite', (s) => {
        s.delete(KEY);
      });
    },
  };
}
