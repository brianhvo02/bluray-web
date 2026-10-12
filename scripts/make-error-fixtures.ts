import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CodingType } from '../src/engine/bdmv/stream-types';
import { buildSyntheticDisc, syntheticClip } from '../tests/helpers/synthetic-disc';

function write(outDir: string, files: ReadonlyMap<string, Uint8Array>, skip: (path: string) => boolean = () => false): void {
  rmSync(outDir, { recursive: true, force: true });
  for (const [path, bytes] of files) {
    if (skip(path)) continue;
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  console.log(`wrote ${outDir}`);
}

// A disc whose playlist declares VC-1 video (fake AVC payload; it is rejected before decoding).
write(
  'fixtures/synthetic/vc1-disc',
  buildSyntheticDisc({
    clips: [syntheticClip('00001', 2, { audio: CodingType.LPCM })],
    playlists: [{ id: '00000', clipIds: ['00001'], videoCodingType: CodingType.VC1 }],
  }),
);

// A partial backup: playlists and clip info, but no BDMV/STREAM.
write(
  'fixtures/synthetic/partial-disc',
  buildSyntheticDisc({
    clips: [syntheticClip('00001', 2, { audio: CodingType.LPCM })],
    playlists: [{ id: '00000', clipIds: ['00001'] }],
  }),
  (path) => path.startsWith('BDMV/STREAM/'),
);
