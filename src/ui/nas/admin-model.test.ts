import { describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES, TMDB_ATTRIBUTION, countdown, deviceRow, deleteTitleQuestion, gateSwitchOn, lastSeen, matchingStatus, newCode, ownTitleKind, ownTitles, revoke, withGate, type AdminApi } from './admin-model';
import type { TitleSummary } from '../../engine/disc/nas-api';
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
    expect(deviceRow(device(), NOW, 'other', DATES)).toEqual({ id: 'd1', text: 'Mum · paired 3 Oct 2026 · last seen 5 minutes ago', thisDevice: false });
  });

  it("marks this device's own row", () => {
    const row = deviceRow(device({ id: 'me', name: 'iPad' }), NOW, 'me', DATES);
    expect(row.text).toBe('iPad (this device) · paired 3 Oct 2026 · last seen 5 minutes ago');
    expect(row.thisDevice).toBe(true);
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

describe('matchingStatus', () => {
  const status = { running: false, groupsDone: 0, groupsTotal: 0, filed: 12, unsorted: 3, music: 1, lastRunAt: null, tmdb: true, gate: 'owners' } as const;
  it('says how far a run is, or when the last one ended, with the counts', () => {
    expect(matchingStatus({ ...status, running: true, groupsDone: 40, groupsTotal: 120 }, NOW)).toEqual({ progress: 'Matching… 40 of 120 folders', counts: '12 discs filed · 3 unsorted · 1 music', tmdb: null });
    expect(matchingStatus(status, NOW).progress).toBe('Not matched yet');
    expect(matchingStatus({ ...status, lastRunAt: NOW - 3 * MINUTE, filed: 1, unsorted: 0, music: 0 }, NOW)).toEqual({ progress: 'Last matched 3 minutes ago', counts: '1 disc filed · 0 unsorted · 0 music', tmdb: null });
  });
  it('says what matching does without a TMDB key', () => {
    expect(matchingStatus({ ...status, tmdb: false }, NOW).tmdb).toBe('No TMDB key: discs that aren’t anime go to Unsorted.');
  });
});

describe('TMDB_ATTRIBUTION', () => {
  it('is TMDB’s notice, verbatim', () => {
    expect(TMDB_ATTRIBUTION).toBe('This product uses the TMDB API but is not endorsed or certified by TMDB');
  });
});

describe('the gate switch', () => {
  const status = { running: false, groupsDone: 0, groupsTotal: 0, filed: 0, unsorted: 0, music: 0, lastRunAt: null, tmdb: true, gate: 'owners' } as const;
  it("shows the NAS's gate: on for everyone, off for owners or before the status loads", () => {
    expect(gateSwitchOn({ ...status, gate: 'everyone' }, false)).toBe(true);
    expect(gateSwitchOn(status, false)).toBe(false);
    expect(gateSwitchOn(null, false)).toBe(false);
  });
  it('shows on while turning it on waits for confirmation', () => {
    expect(gateSwitchOn(status, true)).toBe(true);
  });
  it('follows a successful PUT', () => {
    expect(gateSwitchOn(withGate(status, 'everyone'), false)).toBe(true);
    expect(gateSwitchOn(withGate({ ...status, gate: 'everyone' }, 'owners'), false)).toBe(false);
    expect(withGate(null, 'everyone')).toBeNull();
  });
});

describe('own titles in NAS settings', () => {
  const title = (id: string, kind: TitleSummary['kind'], display: string, own: boolean, seasons = 0): TitleSummary => ({
    id, kind, names: { english: own ? null : display, romaji: null, native: null, synonyms: [], display: own ? display : null },
    poster: null, year: null, seasons, discs: 0, addedAt: 0, own,
  });
  it('lists only own titles, A–Z', () => {
    const list = [title('own:b', 'music', 'live 2024', true), title('anilist:1', 'series', 'Aardvark', false), title('own:a', 'series', 'Harbor Tales', true, 2)];
    expect(ownTitles(list).map((t) => t.id)).toEqual(['own:a', 'own:b']);
  });
  it('names the kind, with a series’ seasons', () => {
    expect(ownTitleKind(title('own:a', 'series', 'Harbor Tales', true, 2))).toBe('Series · 2 seasons');
    expect(ownTitleKind(title('own:a', 'series', 'Harbor Tales', true, 1))).toBe('Series · 1 season');
    expect(ownTitleKind(title('own:b', 'movie', 'Night Film', true))).toBe('Movie');
    expect(ownTitleKind(title('own:c', 'music', 'Live 2024', true))).toBe('Music');
  });
  it('asks before deleting', () => {
    expect(deleteTitleQuestion('Live 2024')).toBe('Delete Live 2024? Its discs go back to Unsorted.');
  });
});
