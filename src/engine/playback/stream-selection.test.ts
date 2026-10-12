import { describe, expect, it } from 'vitest';
import type { StreamEntry } from '../bdmv/mpls-parser';
import { CodingType } from '../bdmv/stream-types';
import { chooseStreams } from './stream-selection';

const entry = (pid: number, codingType: number, subPath = false): StreamEntry => ({ pid, codingType, format: 0, rate: 0, lang: 'eng', subPath });

describe('chooseStreams', () => {
  it('picks the first main-path video and the first playable audio', () => {
    const choice = chooseStreams({
      video: [entry(0x1b00, CodingType.AVC, true), entry(0x1011, CodingType.AVC)],
      audio: [entry(0x1100, CodingType.AC3), entry(0x1101, CodingType.LPCM)],
      pg: [],
      ig: [],
    });
    expect(choice.video?.pid).toBe(0x1011);
    expect(choice.audio?.pid).toBe(0x1101);
    expect(choice.unsupportedAudio).toEqual([]);
  });

  it('reports unsupported audio when nothing is playable', () => {
    const choice = chooseStreams({ video: [entry(0x1011, CodingType.AVC)], audio: [entry(0x1100, CodingType.TRUEHD), entry(0x1101, CodingType.DTSHD_MASTER)], pg: [], ig: [] });
    expect(choice.audio).toBeNull();
    expect(choice.unsupportedAudio.map((a) => a.codingType)).toEqual([CodingType.TRUEHD, CodingType.DTSHD_MASTER]);
  });

  it('handles playlists without audio or video', () => {
    expect(chooseStreams({ video: [], audio: [], pg: [], ig: [] })).toEqual({ video: null, audio: null, unsupportedAudio: [] });
  });
});
