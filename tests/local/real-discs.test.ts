import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodingType } from '../../src/engine/bdmv/stream-types';
import { analyzeAvc, avcCodecString } from '../../src/engine/decode/h264';
import { analyzeHevc, hevcCodecString } from '../../src/engine/decode/hevc';
import { hasSps } from '../../src/engine/decode/video-decoder';
import { FileSource } from '../../src/engine/disc/file-source';
import { loadClips, openDisc, streamPath } from '../../src/engine/disc/open-disc';
import { normalizeDiscPaths } from '../../src/engine/disc/paths';
import { M2tsReader } from '../../src/engine/demux/m2ts-reader';
import { Timeline } from '../../src/engine/nav/timeline';
import { chooseStreams } from '../../src/engine/playback/stream-selection';

const LOCAL = 'fixtures/local';

function localDiscs(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .map((name) => join(LOCAL, name))
    .filter((dir) => existsSync(join(dir, 'BDMV')));
}

/**
 * Blob stand-in that reads ranges straight from the file. Node's `fs.openAsBlob` reports sizes modulo
 * 2^32 (an 8 GB clip appears as 3.5 GB), and Blu-ray clips are routinely larger than 4 GiB.
 * FileSource only needs `size` and `slice().arrayBuffer()`.
 */
function fileBlob(path: string, start = 0, end = statSync(path).size): Blob {
  return {
    size: Math.max(0, end - start),
    slice: (from = 0, to?: number): Blob => fileBlob(path, start + from, Math.min(end, to === undefined ? end : start + to)),
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      const buf = new Uint8Array(Math.max(0, end - start));
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buf, 0, buf.length, start);
      } finally {
        closeSync(fd);
      }
      return buf.buffer;
    },
  } as unknown as Blob;
}

async function entriesOf(dir: string): Promise<Array<[string, Blob]>> {
  const out: Array<[string, Blob]> = [];
  const walk = async (path: string): Promise<void> => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) await walk(full);
      else out.push([relative(dir, full).split(sep).join('/'), fileBlob(full)]);
    }
  };
  await walk(dir);
  return out;
}

const discs = localDiscs();

describe.skipIf(discs.length === 0)('local discs', () => {
  for (const dir of discs) {
    it(`parses and demuxes ${dir}`, async () => {
      const source = new FileSource(normalizeDiscPaths(await entriesOf(dir)));
      const disc = await openDisc(source);
      const main = disc.summaries.find((s) => s.playable);
      expect(main, 'a playable playlist').toBeDefined();
      if (!main) return;
      const mpls = disc.playlists.get(main.id);
      if (!mpls) throw new Error(`playlist ${main.id} vanished`);

      const timeline = new Timeline(mpls.playItems);
      expect(Math.abs(timeline.durationUs - main.durationUs)).toBeLessThan(1000);
      const clips = await loadClips(source, main.clipIds);
      for (const clip of clips.values()) {
        for (const map of clip.epMaps) {
          map.entries.forEach((e, i) => {
            if (i > 0) expect(e.spn).toBeGreaterThanOrEqual(map.entries[i - 1].spn);
          });
        }
      }

      const choice = chooseStreams(mpls.playItems[0].stn);
      const video = choice.video;
      expect(video, 'a main-path video stream').not.toBeNull();
      if (!video) return;
      const reader = new M2tsReader({ source, path: streamPath(mpls.playItems[0].clipId), startSpn: 0, pids: new Set([video.pid]) });
      const first = (await reader.next())?.find((p) => hasSps(video.codingType, p.payload));
      if (video.codingType === CodingType.AVC || video.codingType === CodingType.HEVC) {
        expect(first, 'an access unit with SPS in the first 2 MB').toBeDefined();
        if (!first) return;
        const sps = (video.codingType === CodingType.AVC ? analyzeAvc : analyzeHevc)(first.payload).sps;
        if (!sps) throw new Error('SPS disappeared');
        const codec = video.codingType === CodingType.AVC ? avcCodecString(sps) : hevcCodecString(sps);
        expect(codec).toMatch(/^(avc1|hev1)\./);
        console.info(`${dir}: main=${main.id} ${(main.durationUs / 60e6).toFixed(1)} min, ${codec}, audio=${choice.audio ? 'LPCM' : choice.unsupportedAudio.map((a) => a.codingType.toString(16)).join('/')}, bdj=${disc.usesBdj}`);
      }
      expect(reader.stats.corruptPackets).toBe(0);

      // The end of the clip too: real clips are often > 4 GiB, where truncated file handles go silent.
      const firstClipId = mpls.playItems[0].clipId;
      const lastEp = clips.get(firstClipId)?.epMaps.find((m) => m.pid === video.pid)?.entries.at(-1);
      if (!lastEp) throw new Error(`clip ${firstClipId} has no EP map for the video PID`);
      const tail = new M2tsReader({ source, path: streamPath(firstClipId), startSpn: lastEp.spn, pids: new Set([video.pid]) });
      const tailUnits = [];
      for (let batch = await tail.next(); batch !== null; batch = await tail.next()) tailUnits.push(...batch); // last PES completes on flush
      expect(tailUnits.length, `video PES after the last entry point (SPN ${lastEp.spn})`).toBeGreaterThan(0);
      expect(tail.stats.corruptPackets).toBe(0);
    }, 60_000);
  }
});
