import type { NasHistory } from './nas-history';

/** The address bar is brought up to date at most this often while a disc plays (spec §5.1)... */
const REPLACE_EVERY_MS = 5000;
/** ...and at once when the time moved this much further than playing on would have taken it (a seek). */
const JUMP_US = 2_000_000;

export interface PlayingState {
  readonly currentPlaylistId: string | null;
  readonly timeUs: number;
  readonly engineState: string;
}

/**
 * Keeps `/nas/play/<discKey>?pl=&t=` current while a NAS disc plays, so the address bar is always a link to "here,
 * now". The pre-flight starts it when it launches a disc; a local or disc-server disc never does, so its playback leaves
 * the address bar alone. It writes only while the address bar is on a play route: Back has gone elsewhere otherwise.
 */
export class PlayingRoute {
  private key: string | null = null;
  private lastReplaceMs = -Infinity;
  private last: { readonly state: PlayingState; readonly atMs: number } | null = null;

  constructor(
    private readonly history: Pick<NasHistory, 'route' | 'replace'>,
    private readonly nowMs: () => number,
  ) {}

  /** The disc whose playback the address bar follows, or null. */
  get discKey(): string | null {
    return this.key;
  }

  start(discKey: string): void {
    this.key = discKey;
    this.lastReplaceMs = -Infinity;
    this.last = null;
  }

  update(s: PlayingState): void {
    const key = this.key;
    if (key === null || s.currentPlaylistId === null) return;
    const now = this.nowMs();
    const last = this.last;
    this.last = { state: s, atMs: now };
    // The first playlist's start doesn't write: a link's own time is in the address bar until playback moves on (the
    // link's seek, a pause, or the first 5 s).
    if (last === null) {
      this.lastReplaceMs = now;
      return;
    }
    const expectedUs = last.state.timeUs + (last.state.engineState === 'playing' ? (now - last.atMs) * 1000 : 0);
    const paused = s.engineState === 'paused' && last.state.engineState !== 'paused';
    const jumped = Math.abs(s.timeUs - expectedUs) > JUMP_US;
    const otherPlaylist = last.state.currentPlaylistId !== s.currentPlaylistId;
    if (now - this.lastReplaceMs < REPLACE_EVERY_MS && !paused && !jumped && !otherPlaylist) return;
    if (this.history.route()?.kind !== 'play') return;
    this.lastReplaceMs = now;
    this.history.replace({ kind: 'play', discKey: key, playlistId: s.currentPlaylistId, timeS: Math.floor(s.timeUs / 1e6) });
  }

  stop(): void {
    this.key = null;
    this.last = null;
  }
}
