import { describe, expect, it } from 'vitest';
import { loadsEveryPoster } from './poster-reach';

describe('loadsEveryPoster', () => {
  it('loads every poster over HTTPS when the browser says nothing about the connection (Safari, Firefox)', () => {
    expect(loadsEveryPoster('https', undefined)).toBe(true);
    expect(loadsEveryPoster('https', { type: 'wifi', effectiveType: '4g' })).toBe(true);
  });

  it('loads only what is within scroll range over WebRTC or the relay, or when unpaired', () => {
    expect(loadsEveryPoster('webrtc', undefined)).toBe(false);
    expect(loadsEveryPoster('relay', { type: 'wifi' })).toBe(false);
    expect(loadsEveryPoster(null, undefined)).toBe(false);
  });

  it('loads only what is within scroll range on Data Saver, a cellular connection, or 3G and below', () => {
    expect(loadsEveryPoster('https', { saveData: true })).toBe(false);
    expect(loadsEveryPoster('https', { type: 'cellular', effectiveType: '4g' })).toBe(false);
    expect(loadsEveryPoster('https', { effectiveType: '3g' })).toBe(false);
    expect(loadsEveryPoster('https', { effectiveType: 'slow-2g' })).toBe(false);
  });
});
