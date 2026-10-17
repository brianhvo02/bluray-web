import { describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES, countdown, deviceRow, lastSeen, newCode, revoke, type AdminApi } from './admin-model';
import { NasHttpError, type NasDevice } from './nas-client';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const DATES = { locale: 'en-GB', timeZone: 'UTC' } as const;

const device = (over: Partial<NasDevice> = {}): NasDevice => ({
  id: 'd1',
  name: 'Mum',
  owner: false,
  pairedAt: Date.UTC(2026, 9, 3, 9, 30),
  lastSeen: NOW - 5 * MINUTE,
  ...over,
});

function fakeApi(over: Partial<AdminApi> = {}): AdminApi {
  return {
    devices: vi.fn(async () => []),
    createCode: vi.fn(async (owner: boolean) => ({ code: 'K7QM-4XP2-R9TD', link: `https://bluray-web.pages.dev/?pair=K7QM4XP2R9TD&owner=${owner}`, expiresAt: NOW + 10 * MINUTE })),
    revokeDevice: vi.fn(async () => {}),
    rescan: vi.fn(async () => {}),
    ...over,
  };
}

describe('deviceRow', () => {
  it('reads name · paired <date> · last seen <relative>', () => {
    expect(deviceRow(device(), NOW, 'other', DATES)).toEqual({ id: 'd1', text: 'Mum · paired 3 Oct 2026 · last seen 5 minutes ago' });
  });

  it("marks this device's own row", () => {
    expect(deviceRow(device({ id: 'me', name: 'iPad' }), NOW, 'me', DATES).text).toBe('iPad (this device) · paired 3 Oct 2026 · last seen 5 minutes ago');
  });
});

describe('lastSeen', () => {
  it('says just now under a minute', () => {
    expect(lastSeen(NOW - 59_000, NOW)).toBe('just now');
    expect(lastSeen(NOW + 2_000, NOW)).toBe('just now');
  });

  it('counts minutes, hours and days, singular for one', () => {
    expect(lastSeen(NOW - MINUTE, NOW)).toBe('1 minute ago');
    expect(lastSeen(NOW - 59 * MINUTE, NOW)).toBe('59 minutes ago');
    expect(lastSeen(NOW - HOUR, NOW)).toBe('1 hour ago');
    expect(lastSeen(NOW - 23 * HOUR - 59 * MINUTE, NOW)).toBe('23 hours ago');
    expect(lastSeen(NOW - DAY, NOW)).toBe('1 day ago');
    expect(lastSeen(NOW - 40 * DAY, NOW)).toBe('40 days ago');
  });
});

describe('countdown', () => {
  it('shows minutes and seconds left, rounded up', () => {
    expect(countdown(NOW + 10 * MINUTE, NOW)).toBe('Expires in 10:00');
    expect(countdown(NOW + 10 * MINUTE, NOW + 1)).toBe('Expires in 10:00');
    expect(countdown(NOW + 10 * MINUTE, NOW + 1_000)).toBe('Expires in 9:59');
    expect(countdown(NOW + 65_000, NOW)).toBe('Expires in 1:05');
  });

  it('says Expired once the time is up', () => {
    expect(countdown(NOW, NOW)).toBe('Expired');
    expect(countdown(NOW, NOW + 5_000)).toBe('Expired');
  });
});

describe('newCode', () => {
  it('mints a guest code while the Owner box is off', async () => {
    const api = fakeApi();
    await newCode(api, false);
    expect(api.createCode).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('mints an owner code when the Owner box is ticked', async () => {
    const api = fakeApi();
    await newCode(api, true);
    expect(api.createCode).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe('revoke', () => {
  it('revokes the device and reports no error', async () => {
    const api = fakeApi();
    expect(await revoke(api, 'd1')).toBeNull();
    expect(api.revokeDevice).toHaveBeenCalledExactlyOnceWith('d1');
  });

  it("says the last owner can't be removed when the NAS answers 409 last-owner", async () => {
    const api = fakeApi({ revokeDevice: vi.fn(async () => Promise.reject(new NasHttpError(409, 'last-owner'))) });
    expect(await revoke(api, 'me')).toBe("You can't remove the last owner.");
    expect(ADMIN_MESSAGES.lastOwner).toBe("You can't remove the last owner.");
  });

  it("passes other failures' messages on", async () => {
    const api = fakeApi({ revokeDevice: vi.fn(async () => Promise.reject(new NasHttpError(404, 'unknown device'))) });
    expect(await revoke(api, 'gone')).toBe('The NAS answered 404 (unknown device).');
  });
});
