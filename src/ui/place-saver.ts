import type { PlaybackPlace } from '../engine/disc/nas-api';
import type { PlaceState } from '../engine/protocol';
import { splitPick } from '../player/drop-files';
import type { PlayerSnapshot } from '../player/player-controller';
import { NasHttpError, type NasClient } from './nas/nas-client';
import { buildPlace, PLACE_MIN_DURATION_US, qualifies } from './place-model';
import { placeKey, type PlaceStore, type StoredTextFile } from './place-store';

/** A local disc's places name their device this way ("Stopped at 3:12 of 24:00 on this device"). */
export const LOCAL_DEVICE_NAME = 'this device';
/** Spec 2026-10-20 §6.2: saved this often while playing. */
export const SAVE_EVERY_MS = 10_000;
/** A time that moves this much more (or less) than the clock did between two snapshots was a seek. */
const SEEK_JUMP_US = 2_000_000;
/** What the NAS accepts in a place's text files (server/src/playback-store.ts). */
const MAX_TEXT_FILES = 64;
const MAX_TEXT_FILE_NAME = 512;

/** The disc a save is for, as its launch knows it. */
export interface PlaceTarget {
  /** `discKeyOf` of the disc's files: an `f.` key (content fingerprint), else `d.<disc id>`. */
  readonly discKey: string;
  /** The NAS's disc id; null for a local folder or a disc-server disc. */
  readonly discId: string | null;
  /** A NAS disc: places also go to the NAS. Otherwise they stay on this device. */
  readonly remote: boolean;
  /** The playlist the user launched (an episode, a link), which makes a place at any length. */
  readonly chosen: string | null;
  /** The disc's main title, which makes a place at any length. */
  readonly mainPlaylistId: string | null;
  readonly deviceName: string;
}

export interface PlaceSaverDeps {
  readonly store: PlaceStore;
  /** Where a NAS disc's places go; null with no NAS paired. */
  readonly nas: Pick<NasClient, 'putPlace'> | null;
  /** The engine's registers (PlayerController.readPlace): answered in command order. */
  readonly readPlace: () => Promise<PlaceState>;
  /** PlayerController.discOpens: a read made under another open is not this disc's. */
  readonly discOpens: () => number;
  readonly nowMs: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** PLACE_MIN_DURATION_US, or `?placemin=` (placeMinDurationUs). */
  readonly minDurationUs?: number;
  readonly log?: (message: string, err: unknown) => void;
}

interface Active extends PlaceTarget {
  /** The controller's open count when the disc opened: reads under another open are dropped. */
  readonly opens: number;
}

interface Seen {
  readonly snapshot: PlayerSnapshot;
  readonly shaderSet: string | null;
  readonly atMs: number;
}

/** The registers last read for a playlist of the open disc, for a save that can't wait for a read. */
interface Cached {
  readonly opens: number;
  readonly playlistId: string;
  readonly place: PlaceState;
}

/** What a save carries besides the registers: tracks, subtitles and their offsets, scale, shader. */
function settingsOf(seen: Seen): string {
  const s = seen.snapshot;
  const subs = s.subtitles;
  return JSON.stringify([s.selectedAudio, subs?.selected ?? null, subs?.scale ?? null, subs?.text?.files.map((f) => [f.name, f.startUs, f.offsetMs]) ?? null, seen.shaderSet]);
}

/** Spec §6.2's "at once" saves: a pause (or the end), a seek, a track, offset or shader change. */
function savesAtOnce(prev: Seen, next: Seen): boolean {
  const a = prev.snapshot;
  const b = next.snapshot;
  if (b.engineState !== a.engineState && (b.engineState === 'paused' || b.engineState === 'ended')) return true;
  const expectedUs = a.engineState === 'playing' ? (next.atMs - prev.atMs) * 1000 : 0;
  if (Math.abs(b.timeUs - a.timeUs - expectedUs) > SEEK_JUMP_US) return true;
  return settingsOf(prev) !== settingsOf(next);
}

/** Refused for good: sending it again can't help. */
const refusedForGood = (err: unknown): boolean => err instanceof NasHttpError && (err.status === 400 || err.status === 404 || err.status === 413);

/**
 * Saves the open disc's place (spec 2026-10-20 §6.2): every 10 s while playing and at once on a pause, seek, track,
 * offset or shader change, or when the playlist changes (the one that stopped, where it stopped). Only a qualifying
 * playlist (qualifies) makes a place, so a menu loop after an episode keeps the episode's. Every save goes to the
 * device first; a NAS disc's goes to the outbox and is sent from there, and stays there while the NAS can't be reached.
 */
export class PlaceSaver {
  private target: Active | null = null;
  private seen: Seen | null = null;
  private cached: Cached | null = null;
  private timer: unknown = null;
  /** Saves in order: a write never overtakes an earlier one. */
  private chain: Promise<void> = Promise.resolve();
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  /** Byte sizes of the text files added to this disc, by name (the engine's snapshot has none). */
  private sizes: Record<string, number> = {};
  private readonly minUs: number;

  constructor(private readonly deps: PlaceSaverDeps) {
    this.minUs = deps.minDurationUs ?? PLACE_MIN_DURATION_US;
  }

  /**
   * Starts saving for the disc just opened (call it right after the controller's open). A local disc without a
   * fingerprint (`d.` key, not remote) has nothing to be found by later, so nothing is saved for it.
   */
  begin(target: PlaceTarget): void {
    this.end();
    if (!target.remote && target.discKey.startsWith('d.')) return;
    this.target = { ...target, opens: this.deps.discOpens() };
    void this.drainOutbox();
  }

  /** Stops saving (the disc closes); saves already started still land. */
  end(): void {
    this.stopTimer();
    this.target = null;
    this.seen = null;
    this.cached = null;
    this.sizes = {};
  }

  /** Each snapshot of the player, with the shader set chosen. */
  observe(snapshot: PlayerSnapshot, shaderSet: string | null): void {
    const t = this.target;
    if (!t) return;
    if (this.deps.discOpens() !== t.opens) {
      this.end(); // another disc opened, or this one closed
      return;
    }
    const prev = this.seen;
    const next: Seen = { snapshot, shaderSet, atMs: this.deps.nowMs() };
    this.seen = next;
    if (prev && prev.snapshot.currentPlaylistId !== snapshot.currentPlaylistId) this.savePlaylistLeft(t, prev);
    else if (prev && savesAtOnce(prev, next)) this.save();
    if (snapshot.engineState !== 'playing') this.stopTimer();
    else if (this.timer === null) this.startTimer();
  }

  /**
   * Saves now (a close, the page hidden or going away). With `keepalive` the NAS request is sent at once, alongside the
   * device's write, and outlives the page over HTTPS; the registers read last for this playlist are used when there
   * are some, as a page going away may not live to hear the engine.
   */
  flushNow(opts: { readonly keepalive: boolean }): Promise<void> {
    const t = this.target;
    const seen = this.seen;
    const c = this.cached;
    if (opts.keepalive && t && seen && c && c.opens === t.opens && c.playlistId === seen.snapshot.currentPlaylistId && this.qualifies(t, seen)) {
      return this.write(t, seen, c.place, true).catch((err: unknown) => this.log('saving the place failed', err));
    }
    this.save(opts.keepalive);
    return this.chain;
  }

  /** Sends the places waiting in the outbox, oldest first; one that can't go stops the rest until the next try. */
  drainOutbox(): Promise<void> {
    if (!this.deps.nas) return Promise.resolve();
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    const run = async (): Promise<void> => {
      do {
        this.drainAgain = false;
        await this.sendOutbox();
      } while (this.drainAgain);
    };
    this.draining = run()
      .catch((err: unknown) => this.log('sending saved places failed', err))
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }

  /**
   * Subtitle files the user added (a pick or a drop, as `loadSubtitleFiles` got them): their sizes go into places, and
   * their bytes are kept on this device for a resume here. A pick of fonts alone adds them to the kept set.
   */
  async addTextFiles(files: readonly File[]): Promise<void> {
    const t = this.target;
    if (!t) return;
    const split = splitPick(files);
    // as the controller does: nothing recognised by name means the files are subtitles
    const subtitles = split.subtitles.length || split.fonts.length ? split.subtitles : files;
    for (const f of subtitles) this.sizes[f.name] = f.size;
    const read = (list: readonly File[]): Promise<StoredTextFile[]> => Promise.all(list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const kept = subtitles.length ? [] : await this.deps.store.textFiles(t.discKey);
    await this.deps.store.putTextFiles(t.discKey, [...kept, ...(await read([...subtitles, ...split.fonts]))]);
  }

  private qualifies(t: Active, seen: Seen): boolean {
    return qualifies(seen.snapshot, t.chosen, t.mainPlaylistId, this.minUs);
  }

  /** Reads the registers now (under this disc's open) and saves the latest snapshot with them, after earlier saves. */
  private save(keepalive = false): void {
    const t = this.target;
    const seen = this.seen;
    if (!t || !seen || !this.qualifies(t, seen) || this.deps.discOpens() !== t.opens) return;
    const read = this.deps.readPlace();
    this.chain = this.chain
      .then(async () => {
        const place = await read;
        if (this.target === t) this.cached = { opens: t.opens, playlistId: seen.snapshot.currentPlaylistId!, place };
        await this.write(t, seen, place, keepalive);
      })
      .catch((err: unknown) => this.log('saving the place failed', err));
  }

  /** The playlist changed: the one left is saved where it stopped, with the registers read while it played. */
  private savePlaylistLeft(t: Active, left: Seen): void {
    const c = this.cached;
    if (!c || c.playlistId !== left.snapshot.currentPlaylistId || !this.qualifies(t, left)) return;
    this.chain = this.chain.then(() => this.write(t, left, c.place, false)).catch((err: unknown) => this.log('saving the place failed', err));
  }

  private async write(t: Active, seen: Seen, registers: PlaceState, keepalive: boolean): Promise<void> {
    const built = buildPlace({
      discKey: t.discKey, discId: t.discId ?? '', snapshot: seen.snapshot, place: registers,
      shaderSet: seen.shaderSet, deviceName: t.deviceName, nowMs: this.deps.nowMs(), textFileSizes: this.sizes,
    });
    const place: PlaybackPlace = {
      ...built,
      settings: { ...built.settings, textFiles: built.settings.textFiles.slice(0, MAX_TEXT_FILES).map((f) => ({ ...f, name: f.name.slice(0, MAX_TEXT_FILE_NAME) })) },
    };
    const { store, nas } = this.deps;
    if (!t.remote || !nas) {
      await store.put(place);
      return;
    }
    if (keepalive) {
      // the request leaves before the page can go; the outbox keeps the place should it not arrive
      const sending = nas.putPlace(place, { keepalive: true }).then(
        () => true,
        (err: unknown) => refusedForGood(err),
      );
      await store.put(place);
      await store.queue(place);
      if (await sending) await store.sent(placeKey(place), place.updatedAt);
      return;
    }
    await store.put(place);
    await store.queue(place);
    await this.drainOutbox();
  }

  private async sendOutbox(): Promise<void> {
    const { store, nas } = this.deps;
    if (!nas) return;
    for (const place of await store.outbox()) {
      try {
        await nas.putPlace(place); // 'stale': the NAS holds a newer one, which stays
      } catch (err) {
        if (!refusedForGood(err)) return; // unreachable: the outbox waits for the next save or connection
        this.log('the NAS refused a saved place', err);
      }
      await store.sent(placeKey(place), place.updatedAt);
    }
  }

  private startTimer(): void {
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.save();
      if (this.seen?.snapshot.engineState === 'playing') this.startTimer();
    }, SAVE_EVERY_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private log(message: string, err: unknown): void {
    (this.deps.log ?? ((m, e) => console.warn(m, e)))(message, err);
  }
}
