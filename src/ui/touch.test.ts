import { describe, expect, it } from 'vitest';
import { classifyTap, DOUBLE_TAP_MS, idleAfterTap, pairableTap } from './touch';

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
