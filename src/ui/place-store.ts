import type { DiscPlaces, PlaybackPlace } from '../engine/disc/nas-api';
import { STORES, withStore } from './db';

/** A subtitle (or font) file the user added to a disc, kept on this device so a resume here can add it again. */
export interface StoredTextFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** A file larger than this is not kept. */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
/** A disc's files together past this are not kept at all. */
export const MAX_TEXT_FILES_BYTES = 50 * 1024 * 1024;

/**
 * Places on this device (spec 2026-10-20 §6.2, §6.4): every place saved here, the NAS discs' places waiting to be sent
 * (the outbox), and the subtitle files added per disc. Every save goes here first.
 */
export interface PlaceStore {
  /** Stores a place, unless the one stored for its disc and playlist is newer. */
  put(place: PlaybackPlace): Promise<void>;
  /** A disc's places by playlist id, with the newest place's settings as the disc's defaults. */
  get(discKey: string): Promise<DiscPlaces>;
  /** The places waiting for the NAS, one per disc and playlist. */
  outbox(): Promise<PlaybackPlace[]>;
  /** Puts a place in the outbox, replacing an older one for its disc and playlist. */
  queue(place: PlaybackPlace): Promise<void>;
  /** The NAS took (or refused for good) the place `key` saved at `updatedAt`: out of the outbox unless a newer one came. */
  sent(key: string, updatedAt: number): Promise<void>;
  /** Replaces a disc's files; a file over 5 MB is left out, and a set over 50 MB is not stored. */
  putTextFiles(discKey: string, files: readonly StoredTextFile[]): Promise<void>;
  textFiles(discKey: string): Promise<StoredTextFile[]>;
}

interface PlaceRecord {
  readonly key: string;
  readonly place: PlaybackPlace;
}

interface TextFilesRecord {
  readonly key: string;
  readonly files: readonly StoredTextFile[];
}

/** `<discKey>/<playlistId>`: a place's key on this device. */
export const placeKey = (place: Pick<PlaybackPlace, 'discKey' | 'playlistId'>): string => `${place.discKey}/${place.playlistId}`;

/** Writes `place` unless the store holds a newer one under its key. */
function putNewer(factory: IDBFactory, store: string, place: PlaybackPlace): Promise<unknown> {
  const key = placeKey(place);
  return withStore(factory, store, 'readwrite', (s) => {
    const req = s.get(key) as IDBRequest<PlaceRecord | undefined>;
    req.onsuccess = () => {
      if (!req.result || req.result.place.updatedAt <= place.updatedAt) s.put({ key, place } satisfies PlaceRecord);
    };
  });
}

/** `keyRange` is the browser's `IDBKeyRange` (passed in where there is none, as in the tests). */
export function idbPlaceStore(factory: IDBFactory = indexedDB, keyRange: typeof IDBKeyRange = IDBKeyRange): PlaceStore {
  return {
    async put(place) {
      await putNewer(factory, STORES.places, place);
    },
    async get(discKey) {
      const range = keyRange.bound(`${discKey}/`, `${discKey}/￿`);
      const records = (await withStore(factory, STORES.places, 'readonly', (s) => s.getAll(range) as IDBRequest<PlaceRecord[]>)) ?? [];
      const places: Record<string, PlaybackPlace> = {};
      let newest: PlaybackPlace | null = null;
      for (const { place } of records) {
        places[place.playlistId] = place;
        if (!newest || place.updatedAt > newest.updatedAt) newest = place;
      }
      return { defaults: newest?.settings ?? null, places };
    },
    async outbox() {
      const records = (await withStore(factory, STORES.placeOutbox, 'readonly', (s) => s.getAll() as IDBRequest<PlaceRecord[]>)) ?? [];
      return records.map((r) => r.place);
    },
    async queue(place) {
      await putNewer(factory, STORES.placeOutbox, place);
    },
    async sent(key, updatedAt) {
      await withStore(factory, STORES.placeOutbox, 'readwrite', (s) => {
        const req = s.get(key) as IDBRequest<PlaceRecord | undefined>;
        req.onsuccess = () => {
          if (req.result && req.result.place.updatedAt <= updatedAt) s.delete(key);
        };
      });
    },
    async putTextFiles(discKey, files) {
      const kept = files.filter((f) => f.bytes.byteLength <= MAX_TEXT_FILE_BYTES);
      if (kept.reduce((sum, f) => sum + f.bytes.byteLength, 0) > MAX_TEXT_FILES_BYTES) return;
      await withStore(factory, STORES.localTextFiles, 'readwrite', (s) => {
        s.put({ key: discKey, files: kept } satisfies TextFilesRecord);
      });
    },
    async textFiles(discKey) {
      const record = await withStore(factory, STORES.localTextFiles, 'readonly', (s) => s.get(discKey) as IDBRequest<TextFilesRecord | undefined>);
      return record ? [...record.files] : [];
    },
  };
}
