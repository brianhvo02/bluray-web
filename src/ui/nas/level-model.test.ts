import { describe, expect, it } from 'vitest';
import type { LevelId, LevelInfo, LevelReason } from '../../engine/disc/nas-api';
import { bufferPlan } from './buffer-model';
import {
  BUSY_COPY,
  BUSY_TRY_LATER_COPY,
  ORIGINAL_ONLY,
  autoLevel,
  badgeText,
  busyMessage,
  levelAudio,
  levelRateMbps,
  levelRows,
} from './level-model';

const L = (level: LevelId, budgetMbps: number, available = true, reason?: LevelReason): LevelInfo => ({ level, label: level, budgetMbps, available, ...(reason ? { reason } : {}) });
const film = [L('original', 0), L('h264-1080', 10), L('hevc-1080', 7), L('phone-720', 4)];

describe('level model', () => {
  it('a computer takes Original when it fits with the 1.1 margin', () => expect(autoLevel(film, { connectionMbps: 50, phone: false, originalMbps: 40 })).toBe('original'));
  it('a computer takes the first level that fits, in the server order', () => expect(autoLevel(film, { connectionMbps: 17, phone: false, originalMbps: 40 })).toBe('h264-1080'));
  it('a computer on a slow line takes the lowest rate when nothing fits', () => expect(autoLevel(film, { connectionMbps: 2, phone: false, originalMbps: 40 })).toBe('phone-720'));
  it('a phone takes Phone even on a fast line', () => expect(autoLevel(film, { connectionMbps: 300, phone: true, originalMbps: 40 })).toBe('phone-720'));
  it('a phone without Phone takes the lowest available rate', () => expect(autoLevel([L('original', 0), L('h264-1080', 10), L('hevc-1080', 7)], { connectionMbps: 300, phone: true, originalMbps: 40 })).toBe('hevc-1080'));
  it('an MPEG-2 disc never takes Original', () => expect(autoLevel([L('original', 0, false, 'unplayable'), L('h264-1080', 10)], { connectionMbps: 300, phone: false, originalMbps: 30 })).toBe('h264-1080'));
  it('offers Original alone when the NAS has no levels', () => expect(autoLevel(ORIGINAL_ONLY, { connectionMbps: 2, phone: true, originalMbps: 40 })).toBe('original'));
  it('rate: Original travels at the playlist rate, others at their budget', () => {
    expect(levelRateMbps(film[0]!, 40)).toBe(40);
    expect(levelRateMbps(film[1]!, 40)).toBe(10);
  });

  it('rows say plays now or the wait, and why a level is unavailable', () => {
    const durationS = 7200;
    const o = { durationS, originalBytes: (40 * 1e6 / 8) * durationS, connectionMbps: 17, quotaBytes: 1e12 };
    const rows = levelRows([...film.slice(0, 2), L('hevc-1080', 7, false, 'no-hevc')], o);
    const plan = bufferPlan({ durationS, playlistBytes: o.originalBytes, connectionMbps: 17, quotaBytes: 1e12 });
    if (plan.kind !== 'silent' && plan.kind !== 'ask') throw new Error('expected a wait');
    expect(rows[0]).toEqual({ level: 'original', label: 'original', available: true, note: `about ${Math.ceil(plan.waitS / 60)} minutes` });
    expect(rows[1]!.note).toBe('plays now');
    expect(rows[2]).toMatchObject({ available: false, note: "this device can't decode it" });
  });

  it('rows give every reason its copy and say plays with pauses when too big', () => {
    const o = { durationS: 7200, originalBytes: 1e9, connectionMbps: 100, quotaBytes: 1e12 };
    const reasons: [LevelReason, string][] = [
      ['unplayable', "can't play in this browser"],
      ['no-encoder', 'not on this NAS'],
      ['no-hevc', "this device can't decode it"],
      ['no-hevc10', "this device can't decode it"],
      ['no-hdr-display', 'needs an HDR screen'],
      ['busy', 'the NAS is busy'],
    ];
    const rows = levelRows(reasons.map(([r]) => L('hevc-1080', 7, false, r)), o);
    expect(rows.map((r) => r.note)).toEqual(reasons.map(([, n]) => n));
    const big = levelRows([L('h264-1080', 10)], { ...o, connectionMbps: 5, quotaBytes: 1000 });
    expect(big[0]!.note).toBe('plays with pauses');
  });

  it('busy copy: Original fallback, or try later when Original cannot play', () => {
    expect(BUSY_COPY).toBe('The NAS is busy re-encoding for others. This will play at original quality.');
    expect(BUSY_TRY_LATER_COPY).toBe('The NAS is busy. Try again in a few minutes.');
    expect(busyMessage([L('original', 0), L('h264-1080', 10, false, 'busy')])).toBe(BUSY_COPY);
    expect(busyMessage([L('original', 0, false, 'unplayable'), L('h264-1080', 10, false, 'busy'), L('phone-720', 4, false, 'busy')])).toBe(BUSY_TRY_LATER_COPY);
    expect(busyMessage([L('original', 0, false, 'unplayable'), L('h264-1080', 10, false, 'busy'), L('hevc-1080', 7, false, 'no-hevc')])).toBe(BUSY_TRY_LATER_COPY);
    expect(busyMessage([L('original', 0, false, 'no-encoder'), L('h264-1080', 10, false, 'busy'), L('phone-720', 4, false, 'busy')])).toBe(BUSY_TRY_LATER_COPY);
    expect(busyMessage(film)).toBeNull();
    expect(busyMessage(ORIGINAL_ONLY)).toBeNull();
  });

  it('audio: a saved PSR1 wins, then the browser language, then 1', () => {
    const audio = [{ language: 'jpn' }, { language: 'eng' }];
    expect(levelAudio(audio, { language: 'en-US' })).toBe(2);
    expect(levelAudio(audio, { psr1: 1, language: 'en-US' })).toBe(1);
    expect(levelAudio(audio, { psr1: 9, language: 'en-US' })).toBe(2);
    expect(levelAudio(audio, { language: 'de' })).toBe(1);
    expect(levelAudio([{ language: 'GER' }, { language: 'eng' }], { language: 'de-DE' })).toBe(1);
  });

  it('an unavailable row with no reason says not available', () => {
    const rows = levelRows([{ level: 'hevc-1080', label: 'x', budgetMbps: 7, available: false }], { durationS: 60, originalBytes: 1, connectionMbps: 10, quotaBytes: 1e9 });
    expect(rows[0]!.note).toBe('not available');
  });
  it('autoLevel with nothing available returns original', () => {
    expect(autoLevel([L('h264-1080', 10, false, 'busy')], { connectionMbps: 50, phone: false, originalMbps: 40 })).toBe('original');
    expect(autoLevel([L('h264-1080', 10, false, 'busy')], { connectionMbps: 50, phone: true, originalMbps: 40 })).toBe('original');
  });

  it('badge names the level, and nothing for Original', () => {
    expect(badgeText(L('h264-1080', 10))).toBe('h264-1080 · re-encoded on the NAS');
    expect(badgeText(L('original', 0))).toBeNull();
  });
});
