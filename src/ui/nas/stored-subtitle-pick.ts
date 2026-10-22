import type { StoredSubtitle } from '../../engine/disc/nas-api';
import { splitPick } from '../../player/drop-files';
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
}

/** Whether files picked or dropped replace the text set (as `loadSubtitleFiles` takes them): fonts alone don't. */
export function replacesTextSet(files: readonly File[]): boolean {
  const { subtitles, fonts } = splitPick(files);
  return subtitles.length > 0 || (fonts.length === 0 && files.length > 0);
}

/**
 * Picks a subtitle stored on the NAS in the player: its file and fonts become the text set (replacing any, as a local
 * pick does), placed at its episode's or chapter's start with its default offset, shown, and noted for the place.
 * A failed fetch shows a notice and changes nothing. True once placed; false when the fetch failed, another disc
 * opened, or the engine didn't list the file within TEXT_WAIT_MS (it didn't parse, or the encoding prompt is still up).
 */
export async function pickStoredSubtitle(deps: StoredPickDeps, s: StoredSubtitle): Promise<boolean> {
  const { nas, controller, places } = deps;
  const log = deps.log ?? ((message, err) => console.warn(message, err));
  const opens = controller.discOpens;
  let files: File[];
  try {
    files = await nas.subtitleFiles(s);
  } catch (err) {
    log('fetching the stored subtitle failed', err);
    if (controller.discOpens === opens) controller.showNotice(NOTICE_CODE, STORED_PICK_FAILED);
    return false;
  }
  if (controller.discOpens !== opens) return false;
  // the set before the load: the engine's answer is a new set holding just this file
  const before = deps.snapshot().subtitles?.text ?? null;
  const listed = waitFor(deps, () => {
    const text = deps.snapshot().subtitles?.text;
    return text != null && text !== before && text.files.length === 1 && text.files[0]!.name === s.fileName;
  });
  try {
    await controller.loadSubtitleFiles(files);
  } catch (err) {
    listed.cancel();
    log('loading the stored subtitle failed', err);
    return false;
  }
  if (!(await listed.done) || controller.discOpens !== opens) return false;
  const snap = deps.snapshot();
  const current = snap.subtitles!.text!.files[0]!;
  const start = startFor(s, snap.chapters);
  if (start !== null && start !== current.startUs) controller.setSubtitleStart(0, start);
  if (s.offsetMs !== current.offsetMs) controller.shiftSubtitleFile(0, s.offsetMs - current.offsetMs);
  controller.selectSubtitle({ kind: 'text' });
  places.noteStoredSubtitle(s.fileName, s.id, s.fileSize);
  return true;
}

/** Resolves true when `ready` holds after a snapshot, false past TEXT_WAIT_MS or on cancel. */
function waitFor(deps: StoredPickDeps, ready: () => boolean): { readonly done: Promise<boolean>; cancel(): void } {
  let finish: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    let settled = false;
    const stop = deps.controller.subscribe(() => {
      if (ready()) finish(true);
    });
    const timer = setTimeout(() => finish(false), TEXT_WAIT_MS);
    finish = (ok) => {
      if (settled) return;
      settled = true;
      stop();
      clearTimeout(timer);
      resolve(ok);
    };
  });
  return { done, cancel: () => finish(false) };
}
