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

/**
 * Whether the controls may hide after the idle timeout: only during playback, and not while a control is held, a menu of
 * the control bar is open, or the remote is open over a BD-J menu (the remote sits with the controls and would go too).
 */
export function controlsMayIdle(ctx: { playing: boolean; pressed: boolean; menuOpen: boolean; remoteOpen: boolean; bdjMenuVisible: boolean }): boolean {
  return ctx.playing && !ctx.pressed && !ctx.menuOpen && !(ctx.remoteOpen && ctx.bdjMenuVisible);
}

/** Whether a pointer can hover (a mouse or a pen); a touch pointer cannot. */
export function isHoverPointer(pointerType: string): boolean {
  return pointerType === 'mouse' || pointerType === 'pen';
}

/** Over a disc menu, the mouse wakes the control bar only within this many px of the player's bottom edge (ruling R9). */
export const MENU_WAKE_ZONE_PX = 24;

/** What a hover pointer's move (or press) over a disc menu does to the control bar. */
export type MenuPointerEffect = 'wake' | 'hide' | 'keep';

/**
 * The control bar never covers a disc menu (ruling R9). Over a menu a mouse or pen wakes the bar only within
 * MENU_WAKE_ZONE_PX of the player's bottom edge, or while the pointer is over the shown bar (`barTop`, null when hidden)
 * or on a control (so its buttons can be reached once it shows). Anywhere else the bar hides at once, unless something
 * holds it (a control held down, a bar menu open, the remote open), and then it is left as it is.
 */
export function menuPointerEffect(p: { y: number; playerBottom: number; barTop: number | null; overControls: boolean; held: boolean }): MenuPointerEffect {
  if (p.overControls || p.playerBottom - p.y <= MENU_WAKE_ZONE_PX) return 'wake';
  if (p.barTop !== null && p.y >= p.barTop) return 'wake';
  return p.held ? 'keep' : 'hide';
}

/**
 * Whether the controls show. Outside a menu they always show while paused; over a disc menu an idle bar stays hidden even
 * while paused, since a real player draws nothing over the menu.
 */
export function controlsShown(ctx: { idle: boolean; playing: boolean; inMenu: boolean }): boolean {
  return !ctx.idle || (!ctx.playing && !ctx.inMenu);
}
