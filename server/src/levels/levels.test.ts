import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Clpi } from '../../../src/engine/bdmv/clpi-parser';
import { parseClpi } from '../../../src/engine/bdmv/clpi-parser';
import type { PlayItem, StreamEntry } from '../../../src/engine/bdmv/mpls-parser';
import { LEVELS, coreCoding, keptAudioFor, levelDefFor, levelsFor, mapSpn, planClip, videoAttrsFor } from './levels';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/synthetic');

function clip(entries: Array<{ pts: number; spn: number }>, presentationEnd: number, numSourcePackets = 10_000): Clpi {
  return {
    version: '0200',
    numSourcePackets,
    recordingRate: 6_000_000,
    atcSequences: [{ spnAtcStart: 0, offsetStcId: 0, stc: [{ pcrPid: 0x1001, spnStcStart: 0, presentationStart: entries[0]!.pts, presentationEnd }] }],
    programs: [{ spnProgramSequenceStart: 0, programMapPid: 0x100, streams: [{ pid: 0x1011, codingType: 0x1b, format: 6, rate: 1, lang: '', aspect: 3 }] }],
    epMaps: [{ pid: 0x1011, epStreamType: 1, entries }],
  };
}

describe('planClip', () => {
  it('gives a 1.001 s interval its budget: ⌈duration × (peak + audio + 1.5 Mbps) ÷ 8 ÷ 6144⌉ × 6144', () => {
    const c = clip([{ pts: 450_000, spn: 0 }, { pts: 495_045, spn: 2000 }], 540_090);
    const { intervals } = planClip(c, LEVELS['h264-1080'], 640_000);
    expect(intervals[0]!.budgetBytes).toBe(Math.ceil((1.001 * (10e6 + 640e3 + 1.5e6)) / 8 / 6144) * 6144);
    expect(intervals[0]!.endPts45 - intervals[0]!.startPts45).toBe(45_045);
  });

  it('sums the budgets into the size, and places each interval at the running total ÷ 192', () => {
    const c = parseClpi(readFileSync(join(FIXTURES, 'disc-mpeg2/BDMV/CLIPINF/00001.clpi')));
    const { intervals, sizeBytes } = planClip(c, LEVELS['phone-720'], 448_000);
    const entries = c.epMaps[0]!.entries;
    expect(intervals).toHaveLength(entries.length);
    let total = 0;
    intervals.forEach((iv, i) => {
      expect(iv.index).toBe(i);
      expect(iv.spnStart).toBe(total / 192);
      expect(iv.budgetBytes % 6144).toBe(0);
      expect(iv.budgetBytes).toBeGreaterThan(0);
      expect(iv.startPts45).toBe(entries[i]!.pts);
      expect(iv.srcSpnStart).toBe(i === 0 ? 0 : entries[i]!.spn);
      expect(iv.srcSpnEnd).toBe(i + 1 < entries.length ? entries[i + 1]!.spn : c.numSourcePackets);
      total += iv.budgetBytes;
    });
    expect(sizeBytes).toBe(total);
    // the last interval runs to the end of the STC sequence's presentation
    expect(intervals.at(-1)!.endPts45).toBe(c.atcSequences[0]!.stc[0]!.presentationEnd);
  });

  it('carries a PTS wrap within one STC sequence', () => {
    const c = clip([{ pts: 2 ** 32 - 45_056, spn: 0 }, { pts: 0, spn: 3000 }], 45_056);
    const { intervals } = planClip(c, LEVELS['h264-1080'], 0);
    expect(intervals[0]!.endPts45 - intervals[0]!.startPts45).toBe(45_056);
  });

  it('maps a source SPN to the first interval starting at or after it', () => {
    const c = clip([{ pts: 450_000, spn: 10 }, { pts: 495_045, spn: 2000 }, { pts: 540_090, spn: 4000 }], 585_135);
    const { intervals } = planClip(c, LEVELS['h264-1080'], 0);
    expect(mapSpn(intervals, 0)).toBe(0);
    expect(mapSpn(intervals, 2000)).toBe(intervals[1]!.spnStart);
    expect(mapSpn(intervals, 2001)).toBe(intervals[2]!.spnStart);
  });
});

describe('levelsFor', () => {
  it('never offers original for MPEG-2 or VC-1, but offers the re-encoded levels', () => {
    for (const codingType of [0x02, 0xea]) {
      const levels = levelsFor({ codingType, height: 1080, hdr: false });
      expect(levels).not.toContain('original');
      expect(levels).toEqual(expect.arrayContaining(['h264-1080', 'phone-720', 'hevc-1080']));
    }
  });

  it('offers original plus the 1080p and phone levels for H.264 and HEVC 1080p', () => {
    expect(levelsFor({ codingType: 0x1b, height: 1080, hdr: false })).toEqual(['original', 'h264-1080', 'hevc-1080', 'phone-720']);
    expect(levelsFor({ codingType: 0x24, height: 1080, hdr: false })).toEqual(['original', 'h264-1080', 'hevc-1080', 'phone-720']);
  });

  it('gives UHD HDR the two HDR levels', () => {
    expect(levelsFor({ codingType: 0x24, height: 2160, hdr: true })).toEqual(['original', 'hevc-1080-hdr', 'h264-1080-sdr']);
  });

  it('offers a 720p or smaller source only the phone level besides original', () => {
    expect(levelsFor({ codingType: 0x1b, height: 720, hdr: false })).toEqual(['original', 'phone-720']);
    expect(levelsFor({ codingType: 0x02, height: 480, hdr: false })).toEqual(['phone-720']);
  });
});

describe('levelDefFor', () => {
  it('does not scale a source of 576 lines or fewer up: the phone level keeps its size', () => {
    expect(levelDefFor('phone-720', { height: 576 })).toMatchObject({ width: 720, height: 576, codec: 'h264' });
    expect(levelDefFor('phone-720', { height: 480 })).toMatchObject({ width: 720, height: 480 });
    expect(levelDefFor('phone-720', { height: 720 })).toBe(LEVELS['phone-720']);
    expect(levelDefFor('h264-1080', { height: 1080 })).toBe(LEVELS['h264-1080']);
  });

  it('gives the standard-definition phone level a BD format and rate pair: 576p 25, 480p 29.97', () => {
    expect(videoAttrsFor(levelDefFor('phone-720', { height: 576 }), 3)).toEqual({ newCoding: 0x1b, newFormat: 7, newRate: 3 });
    expect(videoAttrsFor(levelDefFor('phone-720', { height: 480 }), 4)).toEqual({ newCoding: 0x1b, newFormat: 3, newRate: 4 });
  });
});

describe('LEVELS', () => {
  it('has the plan rates, with the peak at 1.25 × target', () => {
    expect(LEVELS['h264-1080']).toMatchObject({ codec: 'h264', width: 1920, height: 1080, targetBps: 8e6, peakBps: 10e6 });
    expect(LEVELS['phone-720']).toMatchObject({ codec: 'h264', width: 1280, height: 720, targetBps: 3e6, peakBps: 3.75e6 });
    expect(LEVELS['hevc-1080']).toMatchObject({ codec: 'hevc', height: 1080, targetBps: 5e6, peakBps: 6.25e6 });
    expect(LEVELS['hevc-1080-hdr']).toMatchObject({ codec: 'hevc', hdr: true, tonemap: false });
    expect(LEVELS['h264-1080-sdr']).toMatchObject({ codec: 'h264', hdr: false, tonemap: true });
    for (const l of Object.values(LEVELS)) expect(l.peakBps).toBe(l.targetBps * 1.25);
  });
});

describe('videoAttrsFor', () => {
  it('writes H.264 or HEVC, the level height\'s format, and keeps the frame rate code (1080i 29.97 becomes 1080p 29.97)', () => {
    expect(videoAttrsFor(LEVELS['h264-1080'], 4)).toEqual({ newCoding: 0x1b, newFormat: 6, newRate: 4 });
    expect(videoAttrsFor(LEVELS['phone-720'], 1)).toEqual({ newCoding: 0x1b, newFormat: 5, newRate: 1 });
    expect(videoAttrsFor(LEVELS['hevc-1080'], 3)).toEqual({ newCoding: 0x24, newFormat: 6, newRate: 3 });
  });
});

describe('coreCoding', () => {
  it('carries TrueHD as AC-3 and DTS-HD as DTS, and the rest as they are', () => {
    expect(coreCoding(0x83)).toBe(0x81);
    expect(coreCoding(0x85)).toBe(0x82);
    expect(coreCoding(0x86)).toBe(0x82);
    for (const c of [0x80, 0x81, 0x82, 0x84]) expect(coreCoding(c)).toBe(c);
  });
});

describe('keptAudioFor (ruling L-R3)', () => {
  const stream = (pid: number, codingType: number, streamType = 1): StreamEntry => ({
    pid,
    codingType,
    format: 3,
    rate: 1,
    lang: 'eng',
    charCode: 0,
    subPath: streamType !== 1,
    streamType,
    subPathId: 0,
    subClipId: 0,
  });
  const item = (audio: StreamEntry[]): PlayItem => ({
    clipId: '00001',
    codecId: 'M2TS',
    connectionCondition: 1,
    stcId: 0,
    inTime: 0,
    outTime: 9000,
    uoMask: new Uint8Array(8),
    stillMode: 0,
    stillTime: 0,
    isMultiAngle: false,
    angleCount: 1,
    angleClipIds: [],
    stn: { video: [], audio, pg: [], ig: [], pipPg: [], secondaryAudio: [], secondaryVideo: [] },
  });

  it('keeps the requested stream when the item has it in the main clip', () => {
    expect(keptAudioFor(item([stream(0x1100, 0x83), stream(0x1101, 0x81)]), 2)).toEqual({ streamNumber: 2, pid: 0x1101, coding: 0x81 });
  });

  it('keeps nothing on an item with no audio', () => {
    expect(keptAudioFor(item([]), 1)).toBeNull();
  });

  it('falls back to stream 1 on an item with fewer tracks than requested', () => {
    expect(keptAudioFor(item([stream(0x1100, 0x83)]), 3)).toEqual({ streamNumber: 1, pid: 0x1100, coding: 0x83 });
  });

  it('never keeps sub-path audio: a sub-path request falls back, and an item with only sub-path audio keeps none', () => {
    expect(keptAudioFor(item([stream(0x1100, 0x81), stream(0x1101, 0x81, 2)]), 2)).toEqual({ streamNumber: 1, pid: 0x1100, coding: 0x81 });
    expect(keptAudioFor(item([stream(0x1100, 0x81, 3)]), 1)).toBeNull();
  });
});
