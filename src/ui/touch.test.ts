import { describe, expect, it } from 'vitest';
import { classifyTap, DOUBLE_TAP_MS, idleAfterTap, pairableTap, tapPoint } from './touch';

const ctx = { width: 900, menuActive: false };

describe('classifyTap', () => {
  it('sends every tap to the menu while a menu is shown', () => {
    const menu = { width: 900, menuActive: true };
    expect(classifyTap(null, { x: 450, timeMs: 0 }, menu)).toBe('menuClick');
    expect(classifyTap({ x: 800, timeMs: 0 }, { x: 800, timeMs: 100 }, menu)).toBe('menuClick');
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

describe('tapPoint', () => {
  it('takes the position from the matching pointerdown (iPadOS reports pointerup at 0,0)', () => {
    expect(tapPoint({ id: 3, x: 165, y: 310 }, { id: 3, x: 0, y: 0 })).toEqual({ x: 165, y: 310 });
  });

  it('falls back to the pointerup position without a matching pointerdown', () => {
    expect(tapPoint(null, { id: 3, x: 40, y: 50 })).toEqual({ x: 40, y: 50 });
    expect(tapPoint({ id: 2, x: 165, y: 310 }, { id: 3, x: 40, y: 50 })).toEqual({ x: 40, y: 50 });
  });
});
