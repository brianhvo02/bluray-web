import { describe, expect, it } from 'vitest';
import { limitMessage, relaySettingsCopy, routeLabel, usageLine } from './relay-model';

const FREE = 1e12;

describe('usageLine', () => {
  it('gives whole GB used, rounded down, of the allowance, with a thousands separator', () => {
    expect(usageLine({ usedBytes: 0, freeBytes: FREE })).toBe('Relay this month: 0 of 1,000 GB free');
    expect(usageLine({ usedBytes: 412.7e9, freeBytes: FREE })).toBe('Relay this month: 412 of 1,000 GB free');
    expect(usageLine({ usedBytes: 1000e9, freeBytes: FREE })).toBe('Relay this month: 1,000 of 1,000 GB free');
  });
});

describe('limitMessage', () => {
  it('gives the exact copy with the reset date in the locale', () => {
    expect(limitMessage('2026-11-01', 'en-US')).toBe("The relay's free allowance for this month is used up. It resets on November 1, 2026.");
  });
});

describe('routeLabel', () => {
  it('names each route a device last used', () => {
    expect(routeLabel('https')).toBe('Home or Tailscale');
    expect(routeLabel('webrtc')).toBe('WebRTC');
    expect(routeLabel('relay')).toBe('WebRTC (relayed)');
    expect(routeLabel(undefined)).toBeNull();
  });
});

describe('relaySettingsCopy', () => {
  it('cites the date the terms were checked', () => {
    expect(relaySettingsCopy.terms).toContain('2026-10-19');
  });
});
