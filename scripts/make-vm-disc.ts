import { CodingType } from '../src/engine/bdmv/stream-types';
import { asm, buildMovieObjects, imm, psr, reg } from '../tests/helpers/hdmv-builders';
import { buildSyntheticDisc, syntheticClip } from '../tests/helpers/synthetic-disc';
import { writeFixture } from './fixture-dir';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: tsx scripts/make-vm-disc.ts <outDir>');
  process.exit(1);
}

/** First Play: every SET operation, compares and branches, a call/resume pair, then playlist 0 and title 1. */
const firstPlay: Uint8Array[] = [
  asm.set('move', reg(0), imm(100)),
  asm.set('move', reg(1), imm(7)),
  asm.set('swap', reg(0), reg(1)), // r0 = 7, r1 = 100
  asm.set('add', reg(0), imm(5)),
  asm.set('sub', reg(0), imm(2)),
  asm.set('mul', reg(0), imm(3)),
  asm.set('div', reg(0), imm(4)), // r0 = 7
  asm.set('mod', reg(1), imm(7)), // r1 = 2
  asm.set('rnd', reg(2), imm(10)),
  asm.set('move', reg(3), imm(0xf0f0)),
  asm.set('and', reg(3), imm(0x0ff0)),
  asm.set('or', reg(3), imm(0x0f00)),
  asm.set('xor', reg(3), imm(0xaaaa)),
  asm.set('move', reg(4), imm(0)),
  asm.set('bitset', reg(4), imm(3)),
  asm.set('bitset', reg(4), imm(5)),
  asm.set('bitclr', reg(4), imm(3)),
  asm.set('move', reg(8), imm(1)),
  asm.set('shl', reg(8), imm(4)),
  asm.set('shr', reg(8), imm(2)),
  asm.set('move', reg(9), psr(4)),
  asm.set('move', reg(6), imm(0)),
];
const loop = firstPlay.length;
firstPlay.push(
  asm.set('add', reg(6), imm(1)),
  asm.cmp('lt', reg(6), imm(3)),
  asm.goto(loop),
  asm.cmp('eq', reg(0), imm(7)),
  asm.set('move', reg(5), imm(1)),
  asm.cmp('ne', reg(0), imm(7)),
  asm.set('move', reg(5), imm(99)), // skipped
  asm.cmp('bc', reg(3), imm(0x0001)),
  asm.set('move', reg(10), imm(1)),
  asm.cmp('ge', reg(1), reg(0)),
  asm.set('move', reg(11), imm(1)), // skipped
  asm.cmp('gt', reg(0), reg(1)),
  asm.set('move', reg(12), imm(1)),
  asm.cmp('le', reg(1), reg(0)),
  asm.set('move', reg(13), imm(1)),
  asm.cmp('lt', reg(0), reg(1)),
  asm.set('move', reg(14), imm(1)), // skipped
  asm.callObject(imm(4)),
  asm.playPl(imm(0)),
  asm.jumpTitle(imm(1)),
);

const movieObjects = buildMovieObjects([
  { cmds: firstPlay }, // 0: first play
  { cmds: [asm.set('move', reg(20), imm(9))] }, // 1: top menu
  { menuCallMask: true, cmds: [asm.playPlPi(imm(1), imm(1)), asm.playPlPm(imm(2), imm(1)), asm.jumpTitle(imm(2))] }, // 2: title 1
  { cmds: [asm.setStream(imm(0x80010000), imm(0)), asm.playPl(imm(0)), asm.jumpObject(imm(5))] }, // 3: title 2
  { cmds: [asm.set('rnd', reg(7), imm(100)), asm.resume()] }, // 4: called from first play
  { cmds: [asm.set('add', reg(15), imm(55))] }, // 5: the program ends here
]);

const clip = (id: string) => syntheticClip(id, 2, { audio: CodingType.LPCM });
const INTERACTIVE = 1;
const files = buildSyntheticDisc({
  clips: [clip('00001'), clip('00002')],
  playlists: [
    { id: '00000', clipIds: ['00001'] },
    { id: '00001', clipIds: ['00001', '00002'], chapterEverySeconds: 1 },
    { id: '00002', clipIds: ['00002'], chapterEverySeconds: 1 },
  ],
  movieObjects,
  index: {
    firstPlay: { kind: 'hdmv', movieObjectId: 0, playbackType: INTERACTIVE },
    topMenu: { kind: 'hdmv', movieObjectId: 1, playbackType: INTERACTIVE },
    titles: [
      { kind: 'hdmv', movieObjectId: 2, playbackType: INTERACTIVE },
      { kind: 'hdmv', movieObjectId: 3, playbackType: INTERACTIVE },
    ],
  },
});

writeFixture(outDir, files);
console.log(`wrote ${files.size} files to ${outDir}`);
