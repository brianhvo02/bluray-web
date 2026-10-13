import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureDir } from './fixture-dir';

const out = fixtureDir('fixtures/synthetic/audio');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** 1 s of 440 Hz at −12 dBFS (the lavfi sine source peaks at 0.125, so gain 2 gives 0.25) in the front left and right channels only, so a downmix keeps it in both. */
function tone(file: string, codec: string[], layout: 'stereo' | '5.1'): void {
  const pan = layout === 'stereo' ? 'pan=stereo|FL=c0|FR=c0' : 'pan=5.1|FL=c0|FR=c0';
  const bytes = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-af', `volume=2,${pan}`, ...codec, '-',
  ], { maxBuffer: 1 << 26 });
  writeFileSync(join(out, file), bytes);
}

tone('tone-ac3-stereo.ac3', ['-c:a', 'ac3', '-b:a', '192k', '-f', 'ac3'], 'stereo');
tone('tone-ac3-51.ac3', ['-c:a', 'ac3', '-b:a', '448k', '-f', 'ac3'], '5.1');
tone('tone-eac3-51.eac3', ['-c:a', 'eac3', '-b:a', '384k', '-f', 'eac3'], '5.1');
tone('tone-dts-51.dts', ['-c:a', 'dca', '-strict', '-2', '-b:a', '768k', '-f', 'dts'], '5.1');
