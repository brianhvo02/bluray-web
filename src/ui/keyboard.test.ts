import { describe, expect, it } from 'vitest';
import { keyActionUo, keyToAction } from './keyboard';

describe('keyToAction', () => {
  it('maps the playback keys from the spec', () => {
    expect(keyToAction(' ')).toEqual({ type: 'togglePlay' });
    expect(keyToAction('ArrowLeft')).toEqual({ type: 'seekBy', deltaUs: -10_000_000 });
    expect(keyToAction('ArrowRight')).toEqual({ type: 'seekBy', deltaUs: 10_000_000 });
    expect(keyToAction('ArrowUp')).toEqual({ type: 'volumeBy', delta: 0.1 });
    expect(keyToAction('ArrowDown')).toEqual({ type: 'volumeBy', delta: -0.1 });
    expect(keyToAction('f')).toEqual({ type: 'fullscreen' });
    expect(keyToAction('F')).toEqual({ type: 'fullscreen' });
    expect(keyToAction('x')).toBeNull();
  });

  it('cycles audio tracks with A', () => {
    expect(keyToAction('a')).toEqual({ type: 'cycleAudio' });
    expect(keyToAction('A')).toEqual({ type: 'cycleAudio' });
  });
});

describe('subtitle keys', () => {
  it('shifts the text subtitles with [ and ] and cycles subtitles with S', () => {
    expect(keyToAction('[')).toEqual({ type: 'subtitleOffset', deltaMs: -100 });
    expect(keyToAction(']')).toEqual({ type: 'subtitleOffset', deltaMs: 100 });
    expect(keyToAction('s')).toEqual({ type: 'cycleSubtitles' });
    expect(keyToAction('S')).toEqual({ type: 'cycleSubtitles' });
  });

  it('leaves the UO check of subtitle keys to the controller', () => {
    const ctx = { playing: true, popupShown: false };
    expect(keyActionUo({ type: 'subtitleOffset', deltaMs: 100 }, ctx)).toBeNull();
    expect(keyActionUo({ type: 'cycleSubtitles' }, ctx)).toBeNull();
  });
});

describe('keyToAction with a menu shown', () => {
  const menu = { menuActive: true };
  it('sends arrows, Enter and digits to the menu', () => {
    expect(keyToAction('ArrowDown', menu)).toEqual({ type: 'menuKey', key: 'down' });
    expect(keyToAction('ArrowUp', menu)).toEqual({ type: 'menuKey', key: 'up' });
    expect(keyToAction('ArrowLeft', menu)).toEqual({ type: 'menuKey', key: 'left' });
    expect(keyToAction('ArrowRight', menu)).toEqual({ type: 'menuKey', key: 'right' });
    expect(keyToAction('Enter', menu)).toEqual({ type: 'menuKey', key: 'ok' });
    expect(keyToAction('7', menu)).toEqual({ type: 'menuKey', key: '7' });
    expect(keyToAction(' ', menu)).toEqual({ type: 'togglePlay' });
  });

  it('keeps the playback meaning of those keys without a menu', () => {
    expect(keyToAction('ArrowDown', { menuActive: false })).toEqual({ type: 'volumeBy', delta: -0.1 });
    expect(keyToAction('Enter', { menuActive: false })).toBeNull();
    expect(keyToAction('7', { menuActive: false })).toBeNull();
  });

  it('opens the top menu with M and the pop-up with P, menu or not', () => {
    for (const ctx of [{ menuActive: true }, { menuActive: false }]) {
      expect(keyToAction('m', ctx)).toEqual({ type: 'menuKey', key: 'topMenu' });
      expect(keyToAction('M', ctx)).toEqual({ type: 'menuKey', key: 'topMenu' });
      expect(keyToAction('p', ctx)).toEqual({ type: 'menuKey', key: 'popup' });
      expect(keyToAction('P', ctx)).toEqual({ type: 'menuKey', key: 'popup' });
    }
  });
});

describe('keyActionUo', () => {
  const ctx = { playing: true, popupShown: false };
  it('names the user operation a key performs', () => {
    expect(keyActionUo({ type: 'togglePlay' }, ctx)).toBe('pauseOn');
    expect(keyActionUo({ type: 'togglePlay' }, { ...ctx, playing: false })).toBeNull();
    expect(keyActionUo({ type: 'seekBy', deltaUs: 1 }, ctx)).toBe('timeSearch');
    expect(keyActionUo({ type: 'cycleAudio' }, ctx)).toBe('primaryAudioChange');
    expect(keyActionUo({ type: 'menuKey', key: 'down' }, ctx)).toBe('moveDown');
    expect(keyActionUo({ type: 'menuKey', key: 'ok' }, ctx)).toBe('activate');
    expect(keyActionUo({ type: 'menuKey', key: 'topMenu' }, ctx)).toBe('menuCall');
    expect(keyActionUo({ type: 'menuKey', key: 'popup' }, ctx)).toBe('popupOn');
    expect(keyActionUo({ type: 'menuKey', key: 'popup' }, { ...ctx, popupShown: true })).toBe('popupOff');
    expect(keyActionUo({ type: 'menuKey', key: '3' }, ctx)).toBeNull();
    expect(keyActionUo({ type: 'volumeBy', delta: 0.1 }, ctx)).toBeNull();
  });
});
