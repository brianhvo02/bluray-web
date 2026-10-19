import { describe, expect, it } from 'vitest';
import { bufferPlan, playlistFacts, storageRoom, waitCopy } from './buffer-model';

/** A 7200 s film averaging 30 Mbps: 27 GB, which the plan needs at 33 Mbps (the average plus 10%). */
const FILM = { durationS: 7200, playlistBytes: (30e6 / 8) * 7200 };
const LOTS = 1e12;

describe('bufferPlan', () => {
  it('plays at once when the connection keeps up with the rate plus 10%', () => {
    expect(bufferPlan({ ...FILM, connectionMbps: 40, quotaBytes: LOTS })).toEqual({ kind: 'play' });
  });

  it('buffers silently when the wait is under 120 s', () => {
    const plan = bufferPlan({ ...FILM, connectionMbps: 32.5, quotaBytes: LOTS });
    expect(plan.kind).toBe('silent');
    if (plan.kind !== 'silent') return;
    expect(plan.waitS).toBeCloseTo(109.09, 1);
    expect(plan.bytes).toBeCloseTo((plan.waitS * 32.5e6) / 8, 0);
  });

  it('asks when the wait is longer', () => {
    const plan = bufferPlan({ ...FILM, connectionMbps: 25, quotaBytes: LOTS });
    expect(plan.kind).toBe('ask');
    if (plan.kind !== 'ask') return;
    expect(plan.waitS).toBeCloseTo(1745.45, 1);
    expect(plan.bytes).toBeCloseTo((plan.waitS * 25e6) / 8, 0);
  });

  it("says how much the device can hold when it can't hold the bytes to wait for", () => {
    const plan = bufferPlan({ ...FILM, connectionMbps: 25, quotaBytes: 2e9 });
    expect(plan).toEqual({ kind: 'too-big', canHoldBytes: 2e9, bytes: expect.closeTo((((7200 * 8) / 33) * 25e6) / 8, 0) });
  });

  it('asks before any wait with a silent threshold of 0 (the ?bufferask=1 test flag)', () => {
    const plan = bufferPlan({ ...FILM, connectionMbps: 32.5, quotaBytes: LOTS, silentBelowS: 0 });
    expect(plan.kind).toBe('ask');
  });

  it('plays when nothing is known about the title', () => {
    expect(bufferPlan({ durationS: 0, playlistBytes: 0, connectionMbps: 1, quotaBytes: LOTS })).toEqual({ kind: 'play' });
  });
});

describe('waitCopy', () => {
  it('rounds the wait up to a whole minute', () => {
    expect(waitCopy(1745)).toBe('About 30 minutes before it can play straight through');
    expect(waitCopy(1800)).toBe('About 30 minutes before it can play straight through');
    expect(waitCopy(1801)).toBe('About 31 minutes before it can play straight through');
  });
});

describe('storageRoom', () => {
  it('asks for persistence first, then gives the quota left', async () => {
    const calls: string[] = [];
    const room = await storageRoom({
      persist: async () => (calls.push('persist'), false),
      estimate: async () => (calls.push('estimate'), { quota: 5e9, usage: 1e9 }),
    });
    expect(calls).toEqual(['persist', 'estimate']);
    expect(room).toBe(4e9);
  });

  it('is 0 without a storage manager, or when it fails', async () => {
    expect(await storageRoom(undefined)).toBe(0);
    expect(await storageRoom({ persist: () => Promise.reject(new Error('no')), estimate: () => Promise.reject(new Error('no')) })).toBe(0);
  });
});

describe('playlistFacts', () => {
  it("sums a playlist's clips once each and its play items' lengths", () => {
    const facts = playlistFacts(
      [
        { clipId: '00001', inTime: 0, outTime: 45_000 * 60 },
        { clipId: '00002', inTime: 45_000 * 10, outTime: 45_000 * 40 },
        { clipId: '00001', inTime: 0, outTime: 45_000 * 30 },
      ],
      new Map([
        ['BDMV/STREAM/00001.M2TS', 1000],
        ['BDMV/STREAM/00002.M2TS', 500],
      ]),
    );
    expect(facts).toEqual({ durationS: 120, playlistBytes: 1500 });
  });
});
