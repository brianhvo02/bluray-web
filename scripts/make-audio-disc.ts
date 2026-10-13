import { execFileSync } from 'node:child_process';
import { CodingType } from '../src/engine/bdmv/stream-types';
import { AudioFramer } from '../src/engine/decode/audio-frames';
import { CLIP_START_PTS, buildSyntheticDisc, lpcmPayload, type SyntheticAudioStream } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-audio-disc.ts <outDir>');
  process.exit(1);
}
const SECONDS = 12;
const TICKS_PER_SAMPLE = 90_000 / 48_000;

function encode(codec: string[], layout: 'stereo' | '5.1'): Uint8Array {
  return new Uint8Array(execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
    '-af', `volume=2,pan=${layout === 'stereo' ? 'stereo|FL=c0|FR=c0' : '5.1|FL=c0|FR=c0'}`, ...codec, '-',
  ], { maxBuffer: 1 << 28 }));
}

/** One codec frame per PES, timed by sample count from the clip start. */
function framed(bytes: Uint8Array, kind: 'ac3' | 'dts', codingType: number, ext?: number): Array<{ pts: number; payload: Uint8Array; streamIdExtension?: number }> {
  const frames = new AudioFramer(kind, codingType).push(bytes, 0);
  let samples = 0;
  return frames.map((f) => {
    const unit = { pts: CLIP_START_PTS + Math.round(samples * TICKS_PER_SAMPLE), payload: f.data, streamIdExtension: ext };
    samples += f.samples;
    return unit;
  });
}

/** TrueHD access units (length in the first 12 bits, in 16-bit words), 24 per PES. */
function truehdUnits(bytes: Uint8Array): Array<{ pts: number; payload: Uint8Array; streamIdExtension: number }> {
  const aus: Uint8Array[] = [];
  for (let at = 0; at + 2 <= bytes.length; ) {
    const len = (((bytes[at] & 0x0f) << 8) | bytes[at + 1]) * 2;
    if (len === 0) break;
    aus.push(bytes.subarray(at, at + len));
    at += len;
  }
  const out = [];
  for (let i = 0; i < aus.length; i += 24) {
    const group = aus.slice(i, i + 24);
    const payload = new Uint8Array(group.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of group) {
      payload.set(a, o);
      o += a.length;
    }
    out.push({ pts: CLIP_START_PTS + Math.round(i * 40 * TICKS_PER_SAMPLE), payload, streamIdExtension: 0x72 });
  }
  return out;
}

const ac3 = encode(['-c:a', 'ac3', '-b:a', '448k', '-f', 'ac3'], '5.1');
const core = encode(['-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3'], 'stereo');
const mlp = encode(['-c:a', 'truehd', '-strict', '-2', '-f', 'truehd'], 'stereo');
const dts = encode(['-c:a', 'dca', '-strict', '-2', '-b:a', '768k', '-f', 'dts'], '5.1');

const lpcmCount = Math.ceil((SECONDS * 90_000) / 450);
const streams: SyntheticAudioStream[] = [
  { pid: 0x1100, codingType: CodingType.LPCM, lang: 'jpn', format: 3, units: Array.from({ length: lpcmCount }, (_, j) => ({ pts: CLIP_START_PTS + j * 450, payload: lpcmPayload(240, j * 240) })) },
  { pid: 0x1101, codingType: CodingType.AC3, lang: 'eng', format: 6, units: framed(ac3, 'ac3', CodingType.AC3) },
  {
    pid: 0x1102,
    codingType: CodingType.TRUEHD,
    lang: 'eng',
    format: 3,
    units: [...framed(core, 'ac3', CodingType.AC3, 0x76), ...truehdUnits(mlp)].sort((a, b) => a.pts - b.pts || (a.streamIdExtension === 0x76 ? -1 : 1)),
  },
  { pid: 0x1103, codingType: CodingType.DTS, lang: 'fra', format: 6, units: framed(dts, 'dts', CodingType.DTS) },
];

const frames = SECONDS * 24;
const files = buildSyntheticDisc({
  clips: [{ clipId: '00001', videoAus: encodeTestVideo(frames), keyIndices: Array.from({ length: SECONDS }, (_, i) => i * 24), startPts: CLIP_START_PTS, audioStreams: streams }],
  playlists: [{ id: '00000', clipIds: ['00001'], chapterEverySeconds: 4 }],
});
writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
