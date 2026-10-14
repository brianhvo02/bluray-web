import { describe, expect, it } from 'vitest';
import { buildClpi, buildIndex, buildMpls } from '../../../tests/helpers/bdmv-builders';
import { CodingType } from '../bdmv/stream-types';
import { DiscError } from './byte-source';
import { FileSource } from './file-source';
import { checkStreamReadable, loadClips, openDisc } from './open-disc';
import { normalizeDiscPaths } from './paths';

const VIDEO = [{ pid: 0x1011, codingType: CodingType.AVC }];

function m2ts(packets: number, syncedPackets = packets): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(packets * 192);
  for (let k = 0; k < syncedPackets; k++) bytes[k * 192 + 4] = 0x47;
  return bytes;
}

function clpi(): Uint8Array<ArrayBuffer> {
  return buildClpi({ numSourcePackets: 64, streams: VIDEO, presentationStart: 0, presentationEnd: 45_000, epMaps: [{ pid: 0x1011, entries: [{ pts: 0, spn: 0 }] }] });
}

function disc(files: Record<string, Uint8Array<ArrayBuffer>>): FileSource {
  return new FileSource(normalizeDiscPaths(Object.entries(files).map(([p, b]) => [p, new Blob([b])] as const)));
}

function baseFiles(): Record<string, Uint8Array<ArrayBuffer>> {
  return {
    'Movie/BDMV/index.bdmv': buildIndex({ firstPlay: { kind: 'hdmv', movieObjectId: 0 }, topMenu: { kind: 'hdmv', movieObjectId: 1 }, titles: [] }),
    'Movie/BDMV/PLAYLIST/00000.mpls': buildMpls({
      playItems: [
        { clipId: '00001', inTime: 0, outTime: 450_000, video: VIDEO },
        { clipId: '00002', inTime: 0, outTime: 225_000, video: VIDEO },
      ],
      marks: [
        { playItemRef: 0, time: 0 },
        { playItemRef: 1, time: 0 },
        { playItemRef: 1, time: 100, type: 2 },
      ],
    }),
    'Movie/BDMV/PLAYLIST/00001.mpls': buildMpls({ playItems: [{ clipId: '00002', inTime: 0, outTime: 45_000, video: VIDEO }] }),
    'Movie/BDMV/CLIPINF/00001.clpi': clpi(),
    'Movie/BDMV/CLIPINF/00002.clpi': clpi(),
    'Movie/BDMV/STREAM/00001.m2ts': m2ts(64),
    'Movie/BDMV/STREAM/00002.m2ts': m2ts(64),
  };
}

describe('openDisc', () => {
  it('summarizes playlists longest first', async () => {
    const model = await openDisc(disc(baseFiles()));
    expect(model.usesBdj).toBe(false);
    expect(model.summaries.map((s) => [s.id, s.durationUs, s.chapterCount, s.playable])).toEqual([
      ['00000', 15_000_000, 2, true],
      ['00001', 1_000_000, 0, true],
    ]);
    expect(model.summaries[0].clipIds).toEqual(['00001', '00002']);
    expect(model.playlists.get('00000')?.playItems).toHaveLength(2);
  });

  it('lists the main feature first and a longer loop playlist last, still listed', async () => {
    const files = baseFiles();
    const segment = { clipId: '00002', inTime: 0, outTime: 45_000, video: VIDEO };
    files['Movie/BDMV/PLAYLIST/00149.mpls'] = buildMpls({ playItems: Array.from({ length: 30 }, () => segment) }); // 30 s, longer than 00000
    const model = await openDisc(disc(files));
    expect(model.summaries.map((s) => [s.id, s.looped])).toEqual([
      ['00000', false],
      ['00001', false],
      ['00149', true],
    ]);
  });

  it('marks playlists with missing clip files as not playable', async () => {
    const files = baseFiles();
    delete files['Movie/BDMV/STREAM/00002.m2ts'];
    const model = await openDisc(disc(files));
    expect(model.summaries.every((s) => !s.playable)).toBe(true);
    expect(model.summaries[0].missingPaths).toEqual(['BDMV/STREAM/00002.M2TS']);
  });

  it('rejects a folder without index.bdmv', async () => {
    const files = baseFiles();
    delete files['Movie/BDMV/index.bdmv'];
    await expect(openDisc(disc(files))).rejects.toMatchObject({ code: 'not-bdmv', paths: ['BDMV/INDEX.BDMV'] });
  });

  it('skips damaged playlists with a warning', async () => {
    const files = baseFiles();
    files['Movie/BDMV/PLAYLIST/00001.mpls'] = new Uint8Array([0x4d, 0x50]);
    const model = await openDisc(disc(files));
    expect(model.summaries.map((s) => s.id)).toEqual(['00000']);
    expect(model.warnings[0]).toContain('00001');
  });

  it('reports an encrypted disc when AACS is present and the stream does not parse', async () => {
    const files = baseFiles();
    files['Movie/BDMV/STREAM/00001.m2ts'] = m2ts(64, 1);
    files['Movie/AACS/Unit_Key_RO.inf'] = new Uint8Array(16);
    await expect(openDisc(disc(files))).rejects.toMatchObject({ code: 'encrypted' });
  });

  it('reports an unreadable stream when it does not parse and there is no AACS folder', async () => {
    const files = baseFiles();
    files['Movie/BDMV/STREAM/00001.m2ts'] = m2ts(64, 1);
    await expect(checkStreamReadable(disc(files), '00001')).rejects.toBeInstanceOf(DiscError);
    await expect(checkStreamReadable(disc(files), '00001')).rejects.toMatchObject({ code: 'unreadable-stream' });
  });

  it('loads clip info for a list of clips', async () => {
    const clips = await loadClips(disc(baseFiles()), ['00001', '00002']);
    expect([...clips.keys()]).toEqual(['00001', '00002']);
    expect(clips.get('00001')?.epMaps[0].entries).toEqual([{ pts: 0, spn: 0 }]);
  });
});
