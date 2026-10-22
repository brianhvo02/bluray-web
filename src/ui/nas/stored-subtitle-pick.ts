import type { StoredSubtitle } from '../../engine/disc/nas-api';
import { pickedSubtitles } from '../../player/drop-files';
import type { PlayerController, PlayerSnapshot } from '../../player/player-controller';
import type { PlaceSaver } from '../place-saver';
import { TEXT_WAIT_MS } from '../place-apply';
import type { NasClient } from './nas-client';
import { startFor } from './subtitle-model';

export const STORED_PICK_FAILED = "Couldn't load the subtitles from the NAS.";
const NOTICE_CODE = 'stored-subtitle';

export interface StoredPickDeps {
  readonly nas: Pick<NasClient, 'subtitleFiles'>;
  readonly controller: Pick<PlayerController, 'discOpens' | 'loadSubtitleFiles' | 'setSubtitleStart' | 'shiftSubtitleFile' | 'selectSubtitle' | 'showNotice' | 'subscribe'>;
  readonly places: Pick<PlaceSaver, 'noteStoredSubtitle'>;
  readonly snapshot: () => PlayerSnapshot;
  readonly log?: (message: string, err: unknown) => void;
  /** TEXT_WAIT_MS by default. */
  readonly waitMs?: number;
}

/** Whether files picked or dropped replace the text set (as `loadSubtitleFiles` takes them): fonts alone don't. */
export function replacesTextSet(files: readonly File[]): boolean {
  return pickedSubtitles(files).length > 0;
}

type WaitResult = 'listed' | 'timeout' | 'abandoned';

/**
 * Picks subtitles stored on the NAS in the player, one at a time: the newest pick (or a local pick, `supersede`)
 * abandons an older one still fetching or waiting, which then applies nothing.
 */
export class StoredSubtitlePicker {
  private generation = 0;
  private abandonWait: (() => void) | null = null;

  constructor(private readonly deps: StoredPickDeps) {}

  /** A local pick replaced the text set: a stored pick in flight applies nothing. */
  supersede(): void {
    this.generation++;
    this.abandonWait?.();
    this.abandonWait = null;
  }

  /**
   * The subtitle's file and fonts become the text set (replacing any, as a local pick does), placed at its episode's
   * or chapter's start with its default offset, shown, and noted for the place. A failed fetch, or an engine that
   * doesn't list the file in time (the encoding prompt aside), shows a notice. True once placed.
   */
  async pick(s: StoredSubtitle): Promise<boolean> {
    this.supersede();
    const gen = this.generation;
    const { nas, controller, places } = this.deps;
    const opens = controller.discOpens;
    const current = (): boolean => gen === this.generation && controller.discOpens === opens;
    let files: File[];
    try {
      files = await nas.subtitleFiles(s);
    } catch (err) {
      this.log('fetching the stored subtitle failed', err);
      if (current()) controller.showNotice(NOTICE_CODE, STORED_PICK_FAILED);
      return false;
    }
    if (!current()) return false;
    // the set before the load: the engine's answer is a new set holding just this file
    const before = this.deps.snapshot().subtitles?.text ?? null;
    const listed = this.waitFor(current, () => {
      const text = this.deps.snapshot().subtitles?.text;
      return text != null && text !== before && text.files.length === 1 && text.files[0]!.name === s.fileName;
    });
    try {
      await controller.loadSubtitleFiles(files);
    } catch (err) {
      if (gen === this.generation) this.supersede();
      this.log('loading the stored subtitle failed', err);
      return false;
    }
    const result = await listed;
    if (result === 'timeout' && current()) controller.showNotice(NOTICE_CODE, STORED_PICK_FAILED);
    if (result !== 'listed' || !current()) return false;
    const snap = this.deps.snapshot();
    // the playlist it is for has given way to another (a disc program moved on): nothing to place it on
    if (snap.currentPlaylistId !== s.attachment.playlistId) return false;
    const loaded = snap.subtitles!.text!.files[0]!;
    const start = startFor(s, snap.chapters);
    if (start !== null && start !== loaded.startUs) controller.setSubtitleStart(0, start);
    if (s.offsetMs !== loaded.offsetMs) controller.shiftSubtitleFile(0, s.offsetMs - loaded.offsetMs);
    controller.selectSubtitle({ kind: 'text' });
    places.noteStoredSubtitle(s.fileName, s.id, s.fileSize, s.language);
    return true;
  }

  /**
   * Waits for `ready` after a snapshot. Gives up ('abandoned') once `current` fails or the pick is superseded, and
   * times out after waitMs without the encoding prompt open: while it is open the clock stops, and starts over once it
   * is answered.
   */
  private waitFor(current: () => boolean, ready: () => boolean): Promise<WaitResult> {
    const waitMs = this.deps.waitMs ?? TEXT_WAIT_MS;
    return new Promise<WaitResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: WaitResult): void => {
        if (settled) return;
        settled = true;
        stop();
        if (timer !== null) clearTimeout(timer);
        if (this.abandonWait === abandon) this.abandonWait = null;
        resolve(result);
      };
      const abandon = (): void => finish('abandoned');
      const clock = (): void => {
        const prompt = this.deps.snapshot().encodingPrompt !== null;
        if (prompt && timer !== null) {
          clearTimeout(timer);
          timer = null;
        } else if (!prompt && timer === null) timer = setTimeout(() => finish('timeout'), waitMs);
      };
      const stop = this.deps.controller.subscribe(() => {
        if (!current()) finish('abandoned');
        else if (ready()) finish('listed');
        else clock();
      });
      this.abandonWait = abandon;
      clock();
    });
  }

  private log(message: string, err: unknown): void {
    (this.deps.log ?? ((m, e) => console.warn(m, e)))(message, err);
  }
}
