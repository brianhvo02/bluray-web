import type { MenuKey } from '../engine/protocol';

export type KeyAction =
  | { readonly type: 'togglePlay' }
  | { readonly type: 'seekBy'; readonly deltaUs: number }
  | { readonly type: 'volumeBy'; readonly delta: number }
  | { readonly type: 'fullscreen' }
  | { readonly type: 'cycleAudio' }
  | { readonly type: 'menuKey'; readonly key: MenuKey };

export interface KeyContext {
  /** A disc menu is shown: arrows, Enter and digits go to it. */
  readonly menuActive: boolean;
}

const MENU_ARROWS: Readonly<Record<string, MenuKey>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok' };

/** Playback keys (spec §7), A (audio track), M (top menu), P (pop-up), and menu keys while a menu is shown. Subtitle keys come in M4. */
export function keyToAction(key: string, ctx: KeyContext = { menuActive: false }): KeyAction | null {
  if (ctx.menuActive) {
    const menuKey = MENU_ARROWS[key] ?? (/^[0-9]$/.test(key) ? (key as MenuKey) : undefined);
    if (menuKey) return { type: 'menuKey', key: menuKey };
  }
  switch (key) {
    case ' ':
      return { type: 'togglePlay' };
    case 'ArrowLeft':
      return { type: 'seekBy', deltaUs: -10_000_000 };
    case 'ArrowRight':
      return { type: 'seekBy', deltaUs: 10_000_000 };
    case 'ArrowUp':
      return { type: 'volumeBy', delta: 0.1 };
    case 'ArrowDown':
      return { type: 'volumeBy', delta: -0.1 };
    case 'f':
    case 'F':
      return { type: 'fullscreen' };
    case 'a':
    case 'A':
      return { type: 'cycleAudio' };
    case 'm':
    case 'M':
      return { type: 'menuKey', key: 'topMenu' };
    case 'p':
    case 'P':
      return { type: 'menuKey', key: 'popup' };
    default:
      return null;
  }
}
