import { describe, expect, it } from 'vitest';
import { beyondLongPressSlop, classifyTap, controlsMayIdle, controlsShown, DOUBLE_TAP_MS, idleAfterTap, isHoverPointer, isMenuLongPress, LONG_PRESS_MS, LONG_PRESS_SLOP_PX, MENU_WAKE_ZONE_PX, menuPointerEffect, missedMenuTapShowsControls, offPicture, pairableTap } from './touch';

const ctx = { width: 900, menuActive: false };

describe('classifyTap', () => {
  it('sends every tap to the menu while a menu is shown', () => {
    const menu = { width: 900, menuActive: true };
    expect(classifyTap(null, { x: 450, timeMs: 0 }, menu)).toBe('menuClick');
    expect(classifyTap({ x: 800, timeMs: 0 }, { x: 800, timeMs: 100 }, menu)).toBe('menuClick');
  });

  it('sends every tap to a BD-J menu while its plane shows anything (Review Focus 3)', () => {
    const bdj = { width: 900, menuActive: false, bdjMenuVisible: true };
    expect(classifyTap(null, { x: 450, timeMs: 0 }, bdj)).toBe('menuClick');
    expect(classifyTap({ x: 800, timeMs: 0 }, { x: 800, timeMs: 100 }, bdj)).toBe('menuClick');
  });

  it('toggles the controls on a tap while a BD-J title plays with an empty plane (Review Focus 3)', () => {
    const feature = { width: 900, menuActive: false, bdjMenuVisible: false };
    expect(classifyTap(null, { x: 450, timeMs: 0 }, feature)).toBe('toggleControls');
    expect(classifyTap({ x: 800, timeMs: 0 }, { x: 800, timeMs: 100 }, feature)).toBe('seekForward');
  });

  it('toggles the controls on a single tap', () => {
    expect(classifyTap(null, { x: 800, timeMs: 1000 }, ctx)).toBe('toggleControls');
  });

  it('seeks on a double tap in the outer thirds', () => {
    expect(classifyTap({ x: 800, timeMs: 0 }, { x: 810, timeMs: 200 }, ctx)).toBe('seekForward');
    expect(classifyTap({ x: 100, timeMs: 0 }, { x: 90, timeMs: DOUBLE_TAP_MS }, ctx)).toBe('seekBack');
  });

  it('toggles the controls on a double tap in the middle', () => {
    expect(classifyTap({ x: 450, timeMs: 0 }, { x: 450, timeMs: 100 }, ctx)).toBe('toggleControls');
  });

  it('treats a second tap after the window as a fresh tap', () => {
    expect(classifyTap({ x: 800, timeMs: 0 }, { x: 800, timeMs: DOUBLE_TAP_MS + 1 }, ctx)).toBe('toggleControls');
  });
});

describe('pairableTap', () => {
  it('keeps a tap for pairing unless it clicked a menu button', () => {
    const tap = { x: 800, timeMs: 0 };
    expect(pairableTap('toggleControls', tap)).toBe(tap);
    expect(pairableTap('menuClick', tap)).toBeNull();
    // a quick tap after a menu click is a fresh tap, not a seek
    expect(classifyTap(pairableTap('menuClick', tap), { x: 800, timeMs: 100 }, ctx)).toBe('toggleControls');
  });
});

describe('idleAfterTap', () => {
  it('flips the controls while playing or buffering', () => {
    expect(idleAfterTap(false, 'playing')).toBe(true);
    expect(idleAfterTap(true, 'playing')).toBe(false);
    expect(idleAfterTap(false, 'buffering')).toBe(true);
  });

  it('leaves them alone while paused, where they are always shown', () => {
    expect(idleAfterTap(false, 'paused')).toBe(false);
    expect(idleAfterTap(true, 'paused')).toBe(true);
  });
});

describe('controlsMayIdle', () => {
  const base = { playing: true, pressed: false, menuOpen: false, remoteOpen: false, inMenu: false };
  it('hides the controls only during playback with nothing held or open', () => {
    expect(controlsMayIdle(base)).toBe(true);
    expect(controlsMayIdle({ ...base, playing: false })).toBe(false);
    expect(controlsMayIdle({ ...base, pressed: true })).toBe(false);
    expect(controlsMayIdle({ ...base, menuOpen: true })).toBe(false);
  });

  it('keeps the controls (and the remote on them) up while the remote is open over a disc menu, HDMV or BD-J', () => {
    expect(controlsMayIdle({ ...base, remoteOpen: true, inMenu: true })).toBe(false);
    expect(controlsMayIdle({ ...base, remoteOpen: true })).toBe(true); // over the feature, as before
    expect(controlsMayIdle({ ...base, inMenu: true })).toBe(true);
  });
});

describe('isHoverPointer', () => {
  it('is true for a mouse or a pen, false for touch', () => {
    expect(isHoverPointer('mouse')).toBe(true);
    expect(isHoverPointer('pen')).toBe(true);
    expect(isHoverPointer('touch')).toBe(false);
  });
});

describe('menuPointerEffect (ruling R9)', () => {
  // a 720 px tall player whose control bar, when shown, starts at y 640
  const base = { y: 300, playerBottom: 720, barTop: null, overControls: false, held: false };

  it('uses a 24 px wake zone', () => {
    expect(MENU_WAKE_ZONE_PX).toBe(24);
  });

  it('wakes the bar only within 24 px of the bottom edge', () => {
    expect(menuPointerEffect({ ...base, y: 720 - 24 })).toBe('wake');
    expect(menuPointerEffect({ ...base, y: 719 })).toBe('wake');
    expect(menuPointerEffect({ ...base, y: 720 - 25 })).toBe('hide');
    expect(menuPointerEffect({ ...base, y: 660 })).toBe('hide'); // where the hidden bar would be: the menu's
  });

  it('hides the bar at once when the pointer goes back up over the menu', () => {
    expect(menuPointerEffect({ ...base, y: 300, barTop: 640 })).toBe('hide');
    expect(menuPointerEffect({ ...base, y: 639, barTop: 640 })).toBe('hide');
  });

  it('keeps a shown bar while the pointer is over it, so its controls can be reached', () => {
    expect(menuPointerEffect({ ...base, y: 650, barTop: 640 })).toBe('wake');
    expect(menuPointerEffect({ ...base, y: 500, overControls: true })).toBe('wake'); // on a control (the remote)
  });

  it('does not hide the bar while a control is held, a bar menu or the remote is open', () => {
    expect(menuPointerEffect({ ...base, held: true })).toBe('keep');
    expect(menuPointerEffect({ ...base, y: 710, held: true })).toBe('wake');
  });
});

describe('controlsShown', () => {
  const base = { idle: false, playing: true, inMenu: false, hiddenByHover: false };
  it('shows the controls when not idle, and always while paused outside a menu', () => {
    expect(controlsShown(base)).toBe(true);
    expect(controlsShown({ ...base, idle: true })).toBe(false);
    expect(controlsShown({ ...base, idle: true, playing: false })).toBe(true);
    expect(controlsShown({ ...base, idle: true, playing: false, hiddenByHover: true })).toBe(true); // no menu: as before
  });

  it('keeps them hidden while paused over a disc menu when a hover pointer hid them (the bar never covers a menu)', () => {
    expect(controlsShown({ ...base, idle: true, playing: false, inMenu: true, hiddenByHover: true })).toBe(false);
    expect(controlsShown({ ...base, idle: false, playing: false, inMenu: true, hiddenByHover: true })).toBe(true);
  });

  it('shows them on pause over a menu when they idled out by the timer (ruling R12)', () => {
    expect(controlsShown({ ...base, idle: true, playing: false, inMenu: true })).toBe(true);
    expect(controlsShown({ ...base, idle: true, playing: true, inMenu: true })).toBe(false);
  });
});

describe('offPicture (rulings R13, R14)', () => {
  it('is any letterbox band around the picture, top and bottom (portrait)', () => {
    const canvas = { left: 0, top: 100, width: 400, height: 800 }; // the picture is 400x225 at y 287-512
    expect(offPicture(200, 100 + 799.5, canvas)).toBe(true); // bottom edge
    expect(offPicture(200, 100 + 700, canvas)).toBe(true); // bottom letterbox, far above the edge
    expect(offPicture(200, 100 + 5, canvas)).toBe(true); // top letterbox
    expect(offPicture(200, 100 + 286, canvas)).toBe(true);
    expect(offPicture(200, 100 + 287, canvas)).toBe(false); // the picture's first row
    expect(offPicture(200, 100 + 511, canvas)).toBe(false); // its last row
    expect(offPicture(200, 100 + 512, canvas)).toBe(true);
  });

  it('is the side bands when the picture is pillarboxed (landscape)', () => {
    const canvas = { left: 0, top: 0, width: 839, height: 412 }; // the picture is 732x412 at x 53-785
    expect(offPicture(20, 200, canvas)).toBe(true);
    expect(offPicture(820, 200, canvas)).toBe(true);
    for (const y of [0, 200, 380, 411.5]) expect(offPicture(400, y, canvas)).toBe(false); // the picture reaches top and bottom
  });

  it('is false off the canvas', () => {
    const canvas = { left: 10, top: 10, width: 400, height: 800 };
    expect(offPicture(5, 20, canvas)).toBe(false);
    expect(offPicture(20, 810, canvas)).toBe(false);
  });
});

describe('long press (ruling R15)', () => {
  it('is 500 ms with a 10 px slop', () => {
    expect(LONG_PRESS_MS).toBe(500);
    expect(LONG_PRESS_SLOP_PX).toBe(10);
  });

  it('allows up to 10 px of movement', () => {
    expect(beyondLongPressSlop({ x: 100, y: 100 }, { x: 106, y: 108 })).toBe(false); // exactly 10 px
    expect(beyondLongPressSlop({ x: 100, y: 100 }, { x: 111, y: 100 })).toBe(true);
  });

  it('is a held, still touch over a disc menu only', () => {
    expect(isMenuLongPress({ inMenu: true, heldMs: 500, moved: false })).toBe(true);
    expect(isMenuLongPress({ inMenu: true, heldMs: 499, moved: false })).toBe(false);
    expect(isMenuLongPress({ inMenu: true, heldMs: 900, moved: true })).toBe(false);
    expect(isMenuLongPress({ inMenu: false, heldMs: 900, moved: false })).toBe(false); // over the feature: an ordinary tap
  });
});

describe('classifyTap off the picture over a menu (rulings R13, R14)', () => {
  const menu = { width: 400, menuActive: true, controlsShown: false };
  it('shows the hidden controls on a tap off the picture, HDMV or BD-J', () => {
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, offPicture: true })).toBe('showControls');
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, menuActive: false, bdjMenuVisible: true, offPicture: true })).toBe('showControls');
  });

  it('sends any other tap to the menu, the picture included', () => {
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, offPicture: false })).toBe('menuClick');
    expect(classifyTap(null, { x: 200, timeMs: 0 }, menu)).toBe('menuClick');
  });

  it('sends a tap off the picture to the menu when the controls already show (a control, or empty bar space)', () => {
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, controlsShown: true, offPicture: true })).toBe('menuClick');
  });

  it('leaves taps outside a menu as they were', () => {
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, menuActive: false, offPicture: true })).toBe('toggleControls');
  });

  it('never pairs a tap that showed the controls into a double tap', () => {
    expect(pairableTap('showControls', { x: 390, timeMs: 0 })).toBeNull();
  });
});

describe('missedMenuTapShowsControls (ruling R13)', () => {
  it('shows the controls for a touch that missed, not for a mouse or pen click', () => {
    expect(missedMenuTapShowsControls('touch')).toBe(true);
    expect(missedMenuTapShowsControls('mouse')).toBe(false);
    expect(missedMenuTapShowsControls('pen')).toBe(false);
  });
});
