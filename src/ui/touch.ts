import type { PlaybackState } from '../engine/protocol';

/** A touch tap on the video: where it landed horizontally and when. */
export interface Tap {
  readonly x: number;
  readonly timeMs: number;
}

export type TapAction = 'toggleControls' | 'seekBack' | 'seekForward' | 'menuClick' | 'none';

/** Two taps within this many ms make a double tap. */
export const DOUBLE_TAP_MS = 300;

/**
 * What a tap on the video does. While a disc menu is shown (an HDMV menu, or a BD-J plane with anything visible) every
 * tap is a click on the menu. Otherwise a single tap toggles the controls, and a second tap within DOUBLE_TAP_MS in the
 * left or right third seeks back or forward.
 */
export function classifyTap(prev: Tap | null, tap: Tap, ctx: { width: number; menuActive: boolean; bdjMenuVisible?: boolean }): TapAction {
  if (ctx.menuActive || ctx.bdjMenuVisible) return 'menuClick';
  if (prev && tap.timeMs - prev.timeMs <= DOUBLE_TAP_MS && ctx.width > 0) {
    if (tap.x < ctx.width / 3) return 'seekBack';
    if (tap.x >= (ctx.width * 2) / 3) return 'seekForward';
  }
  return 'toggleControls';
}

/** The tap a following tap pairs with: a tap that clicked a menu button never starts a double tap. */
export function pairableTap(action: TapAction, tap: Tap): Tap | null {
  return action === 'menuClick' ? null : tap;
}

/**
 * The controls' idle flag after a single tap on the video. Only playback (or buffering) toggles it: while paused the controls
 * are always shown, and flipping the hidden flag would make them vanish the moment play is pressed.
 */
export function idleAfterTap(idle: boolean, state: PlaybackState): boolean {
  return state === 'playing' || state === 'buffering' ? !idle : idle;
}
