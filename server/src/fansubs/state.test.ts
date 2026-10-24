import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FansubTitleState } from '../../../src/engine/disc/nas-api';
import { FansubState } from './state';

const DAY = 86_400_000;
const NOW = 100 * DAY;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fansub-state-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state = (titleId: string, over: Partial<FansubTitleState> = {}): FansubTitleState => ({ titleId, lastRunAt: NOW - DAY, running: false, nothingFound: false, seasons: {}, episodes: {}, ...over });

describe('FansubState', () => {
  it('has no state for an unknown title and keeps what it is given across instances', () => {
    const s = new FansubState(dir);
    expect(s.title('a')).toBeNull();
    const put = state('a', { seasons: { s1: { bestGroup: 'GroupA', usedGroups: [{ group: 'GroupA', rank: 'best' }] } }, episodes: { 's1#1': { status: 'attached' } } });
    s.put(put);
    expect(new FansubState(dir).title('a')).toEqual(put);
  });

  it('says which titles are due: never run, or nothing found 30 days ago', () => {
    const s = new FansubState(dir);
    s.put(state('ran-yesterday'));
    s.put(state('empty-31', { nothingFound: true, lastRunAt: NOW - 31 * DAY }));
    s.put(state('empty-29', { nothingFound: true, lastRunAt: NOW - 29 * DAY }));
    s.put(state('found-long-ago', { lastRunAt: NOW - 90 * DAY }));
    s.put(state('never', { lastRunAt: null }));
    expect(s.due(['unknown', 'ran-yesterday', 'empty-31', 'empty-29', 'found-long-ago', 'never'], NOW)).toEqual(['unknown', 'empty-31', 'never']);
  });

  it('remembers deleted tracks per title, and undelete clears one title only', () => {
    const s = new FansubState(dir);
    expect(s.isDeleted(7, 2)).toBe(false);
    s.markDeleted('a', 7, 2);
    s.markDeleted('a', 7, 2);
    s.markDeleted('b', 9, 1);
    expect(s.isDeleted(7, 2)).toBe(true);
    expect(s.isDeleted(7, 1)).toBe(false);
    expect(new FansubState(dir).isDeleted(7, 2)).toBe(true);
    s.undelete('a');
    expect(s.isDeleted(7, 2)).toBe(false);
    expect(s.isDeleted(9, 1)).toBe(true);
  });

  it('defaults the languages to eng and keeps a change', () => {
    const s = new FansubState(dir);
    expect(s.languages()).toEqual(['eng']);
    s.setLanguages(['eng', 'jpn']);
    expect(new FansubState(dir).languages()).toEqual(['eng', 'jpn']);
  });

  it('starts empty on a damaged file', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'fansubs'), { recursive: true });
    writeFileSync(join(dir, 'fansubs', 'state.json'), '{nope');
    expect(new FansubState(dir).languages()).toEqual(['eng']);
  });
});
