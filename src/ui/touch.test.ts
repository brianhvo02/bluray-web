import { describe, expect, it } from 'vitest';
import { classifyTap, controlsMayIdle, controlsShown, DOUBLE_TAP_MS, idleAfterTap, isHoverPointer, inMenuWakeBand, MENU_TAP_ZONE_PX, MENU_WAKE_ZONE_PX, menuPointerEffect, missedMenuTapShowsControls, pairableTap } from './touch';

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

describe('inMenuWakeBand (rulings R12, R13)', () => {
  it('uses a 48 px band', () => {
    expect(MENU_TAP_ZONE_PX).toBe(48);
  });

  it('is the bottom 48 px of a letterbox under the picture (portrait)', () => {
    const canvas = { top: 100, width: 400, height: 800 }; // the picture is 400x225 at y 287-512
    expect(inMenuWakeBand(100 + 799.5, canvas)).toBe(true);
    expect(inMenuWakeBand(100 + 800, canvas)).toBe(false); // past the canvas
    expect(inMenuWakeBand(100 + 800 - 48, canvas)).toBe(true);
    expect(inMenuWakeBand(100 + 800 - 49, canvas)).toBe(false); // letterbox, but above the band
    expect(inMenuWakeBand(100 + 400, canvas)).toBe(false); // the picture
  });

  it('is only the part of the band below the picture when the letterbox is thinner than the band', () => {
    const canvas = { top: 0, width: 400, height: 265 }; // the picture is 400x225 at y 20-245
    expect(inMenuWakeBand(250, canvas)).toBe(true);
    expect(inMenuWakeBand(245, canvas)).toBe(true);
    expect(inMenuWakeBand(244, canvas)).toBe(false); // in the band, but on the picture
  });

  it('is empty where the picture reaches the bottom edge (landscape)', () => {
    const canvas = { top: 0, width: 839, height: 412 }; // pillarboxed: the picture is full height
    for (const y of [411.5, 400, 380, 364]) expect(inMenuWakeBand(y, canvas)).toBe(false);
  });
});

describe('classifyTap in the menu wake band (rulings R12, R13)', () => {
  const menu = { width: 400, menuActive: true, controlsShown: false };
  it('shows the hidden controls on a tap in the band, HDMV or BD-J', () => {
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, inWakeBand: true })).toBe('showControls');
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, menuActive: false, bdjMenuVisible: true, inWakeBand: true })).toBe('showControls');
  });

  it('sends any other tap to the menu, the picture included', () => {
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, inWakeBand: false })).toBe('menuClick');
    expect(classifyTap(null, { x: 200, timeMs: 0 }, menu)).toBe('menuClick');
  });

  it('sends a tap in the band to the menu when the controls already show (a control, or empty bar space)', () => {
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, controlsShown: true, inWakeBand: true })).toBe('menuClick');
  });

  it('leaves taps outside a menu as they were', () => {
    expect(classifyTap(null, { x: 200, timeMs: 0 }, { ...menu, menuActive: false, inWakeBand: true })).toBe('toggleControls');
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
