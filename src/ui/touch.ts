import type { PlaybackState } from '../engine/protocol';

/** A touch tap on the video: where it landed horizontally and when. */
export interface Tap {
  readonly x: number;
  readonly timeMs: number;
}

export type TapAction = 'toggleControls' | 'seekBack' | 'seekForward' | 'menuClick' | 'showControls' | 'none';

/** Two taps within this many ms make a double tap. */
export const DOUBLE_TAP_MS = 300;

/** Over a disc menu with the controls hidden, a tap within this many px of the player's bottom edge shows them (ruling R12). */
export const MENU_TAP_ZONE_PX = 48;

/**
 * What a tap on the video does. While a disc menu is shown (an HDMV menu, or a BD-J plane with anything visible) a tap is
 * a click on the menu, except that with the controls hidden a tap in the bottom MENU_TAP_ZONE_PX (`fromBottom`, px from
 * the player's bottom edge) shows them: a touch-only user has no other way to bring them back (ruling R12). Otherwise a
 * single tap toggles the controls, and a second tap within DOUBLE_TAP_MS in the left or right third seeks back or forward.
 */
export function classifyTap(
  prev: Tap | null,
  tap: Tap,
  ctx: { width: number; menuActive: boolean; bdjMenuVisible?: boolean; fromBottom?: number; controlsShown?: boolean },
): TapAction {
  if (ctx.menuActive || ctx.bdjMenuVisible) {
    if (ctx.controlsShown === false && ctx.fromBottom !== undefined && ctx.fromBottom <= MENU_TAP_ZONE_PX) return 'showControls';
    return 'menuClick';
  }
  if (prev && tap.timeMs - prev.timeMs <= DOUBLE_TAP_MS && ctx.width > 0) {
    if (tap.x < ctx.width / 3) return 'seekBack';
    if (tap.x >= (ctx.width * 2) / 3) return 'seekForward';
  }
  return 'toggleControls';
}

/** The tap a following tap pairs with: a tap on a menu (a click, or one that showed the controls) never starts a double tap. */
export function pairableTap(action: TapAction, tap: Tap): Tap | null {
  return action === 'menuClick' || action === 'showControls' ? null : tap;
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
 * the control bar is open, or the remote is open over a disc menu, HDMV or BD-J (the remote sits with the controls and
 * would go too).
 */
export function controlsMayIdle(ctx: { playing: boolean; pressed: boolean; menuOpen: boolean; remoteOpen: boolean; inMenu: boolean }): boolean {
  return ctx.playing && !ctx.pressed && !ctx.menuOpen && !(ctx.remoteOpen && ctx.inMenu);
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
 * Whether the controls show. They always show while paused, except over a disc menu when a hover pointer hid them (moving
 * over the menu, ruling R9): then they stay hidden while paused, since a real player draws nothing over the menu. Controls
 * that idled out by the timer show again on pause, as outside a menu (ruling R12).
 */
export function controlsShown(ctx: { idle: boolean; playing: boolean; inMenu: boolean; hiddenByHover: boolean }): boolean {
  return !ctx.idle || (!ctx.playing && !(ctx.inMenu && ctx.hiddenByHover));
}
