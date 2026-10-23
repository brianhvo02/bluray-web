import { execFileSync } from 'node:child_process';
import { CodingType } from '../src/engine/bdmv/stream-types';
import { CLIP_START_PTS, buildSyntheticDisc } from '../tests/helpers/synthetic-disc';
import { SPEECH_BURSTS, SPEECH_CLIP_SPLIT_S, SPEECH_DISC_SECONDS } from '../tests/helpers/speech-bursts';
import { framed } from './audio-units';
import { writeFixture } from './fixture-dir';
import { encodeTestVideo } from './x264';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-speech-disc.ts <outDir>');
  process.exit(1);
}

/** Stereo AC-3 at 192 kb/s: pink noise at -20 dBFS inside the bursts that fall in [fromS, fromS + seconds), silence elsewhere. */
function speechAudio(fromS: number, seconds: number): Uint8Array {
  const gate = SPEECH_BURSTS.map((b) => [b.fromMs / 1000 - fromS, b.toMs / 1000 - fromS] as const)
    .filter(([a, b]) => b > 0 && a < seconds)
    .map(([a, b]) => `between(t,${Math.max(a, 0)},${b})`)
    .join('+');
  return new Uint8Array(execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.3:sample_rate=48000:duration=${seconds}:seed=${fromS + 1}`,
    '-af', `volume='if(${gate},1,0)':eval=frame,pan=stereo|FL=c0|FR=c0`, '-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3', '-',
  ], { maxBuffer: 1 << 28 }));
}

const clip = (clipId: string, fromS: number, seconds: number): Parameters<typeof buildSyntheticDisc>[0]['clips'][number] => {
  const frames = seconds * 24;
  return {
    clipId,
    videoAus: encodeTestVideo(frames, '64x36', ['-crf', '51']),
    keyIndices: Array.from({ length: seconds }, (_, i) => i * 24),
    startPts: CLIP_START_PTS,
    audioStreams: [{ pid: 0x1100, codingType: CodingType.AC3, lang: 'jpn', format: 3, units: framed(speechAudio(fromS, seconds), 'ac3') }],
  };
};

const files = buildSyntheticDisc({
  clips: [clip('00001', 0, SPEECH_CLIP_SPLIT_S), clip('00002', SPEECH_CLIP_SPLIT_S, SPEECH_DISC_SECONDS - SPEECH_CLIP_SPLIT_S)],
  playlists: [{ id: '00000', clipIds: ['00001', '00002'], chapterEverySeconds: 30 }],
});
writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
