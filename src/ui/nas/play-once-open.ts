import { openFailed } from './library-model';

/** Shown when an episode's playlist isn't on the disc it was filed on (ruling T10f). */
export const EPISODE_MISSING_NOTICE = "This episode isn't on this disc; it opened normally.";

/** What `playOnceOpen` needs of the `PlayerController`. */
export interface OpeningController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { readonly playlists: readonly { readonly id: string }[]; readonly engineState: string; readonly error: unknown };
  /** Bumped by every open and close, so a wait begun for one open never acts on another. */
  readonly discOpens: number;
  playPlaylist(playlistId: string): void;
  showNotice(code: string, message: string): void;
}

/**
 * Starts `playlistId` once the engine has read the disc just opened (its 'titles' event). A plain subscription rather
 * than an effect: the landing screen, and the pre-flight with it, unmounts as soon as the disc's playlists arrive.
 *
 * It is scoped to that one open (ruling T10g): it lets go once it has acted, when the open fails, when another disc is
 * opened or this one closed, and when the returned function is called (the pre-flight unmounting first). A disc that
 * hasn't the playlist is left as it opened (its menu or title list, the same as opening it without one) with a notice.
 */
export function playOnceOpen(controller: OpeningController, playlistId: string): () => void {
  const open = controller.discOpens;
  let unsubscribe: (() => void) | null = null;
  const release = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };
  unsubscribe = controller.subscribe(() => {
    const snapshot = controller.getSnapshot();
    if (controller.discOpens !== open || openFailed(snapshot)) {
      release();
      return;
    }
    if (snapshot.playlists.length === 0) return;
    release();
    if (snapshot.playlists.some((p) => p.id === playlistId)) controller.playPlaylist(playlistId);
    else controller.showNotice('episode-missing', EPISODE_MISSING_NOTICE);
  });
  return release;
}
