import { execFileSync } from 'node:child_process';
import { CodingType } from '../src/engine/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc, type SyntheticClipSpec } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';

const [outDir, ...args] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: tsx scripts/make-fixture-disc.ts <outDir> [--seconds-per-clip N]');
  process.exit(1);
}
const flag = args.indexOf('--seconds-per-clip');
const secondsPerClip = flag >= 0 ? Number(args[flag + 1]) : 4;
if (!Number.isInteger(secondsPerClip) || secondsPerClip <= 0) {
  console.error(`--seconds-per-clip must be a positive whole number of seconds (got ${args[flag + 1]})`);
  process.exit(1);
}
const framesPerClip = secondsPerClip * 24;

// IDR every second, no B-frames (so PTS = DTS = frame index), AUD before every access unit,
// SPS/PPS repeated at every IDR so any keyframe can start decoding.
const h264 = execFileSync(
  'ffmpeg',
  [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
    '-frames:v', String(framesPerClip * 2),
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-x264-params', 'keyint=24:min-keyint=24:scenecut=0:bframes=0:aud=1:repeat-headers=1',
    '-f', 'h264', '-',
  ],
  { maxBuffer: 1 << 30 },
);

/** Splits an Annex-B stream at access unit delimiters (NAL type 9). */
function splitAccessUnits(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1 && (stream[i + 3] & 0x1f) === 9) {
      starts.push(i > 0 && stream[i - 1] === 0 ? i - 1 : i);
    }
  }
  return starts.map((s, k) => stream.subarray(s, k + 1 < starts.length ? starts[k + 1] : stream.length));
}

const aus = splitAccessUnits(new Uint8Array(h264));
if (aus.length !== framesPerClip * 2) throw new Error(`expected ${framesPerClip * 2} access units, got ${aus.length}`);

const keyIndices = Array.from({ length: framesPerClip / 24 }, (_, i) => i * 24);
const clip = (clipId: string, from: number): SyntheticClipSpec => ({
  clipId,
  videoAus: aus.slice(from, from + framesPerClip),
  keyIndices,
  startPts: CLIP_START_PTS,
  audio: CodingType.LPCM,
});

const files = buildSyntheticDisc({
  clips: [clip('00001', 0), clip('00002', framesPerClip)],
  playlists: [
    { id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 2 },
    { id: '00001', clipIds: ['00002'] },
  ],
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
