import { describe, expect, it } from 'vitest';
import { AUDIO_PID, VIDEO_PID, buildSyntheticDisc, syntheticClip, syntheticSource } from '../../../tests/helpers/synthetic-disc';
import { parseMpls } from '../bdmv/mpls-parser';
import { CodingType } from '../bdmv/stream-types';
import { DiscError, readWhole } from '../disc/byte-source';
import { loadClips } from '../disc/open-disc';
import { Timeline } from '../nav/timeline';
import { PlaybackPipeline, type PipelineConfig, type PipelineUnit } from './pipeline';

async function setup(): Promise<PipelineConfig> {
  const files = buildSyntheticDisc({
    clips: [syntheticClip('00001', 4, { audio: CodingType.LPCM }), syntheticClip('00002', 4, { audio: CodingType.LPCM })],
    playlists: [{ id: '00000', clipIds: ['00001', '00002'] }],
  });
  const source = syntheticSource(files);
  const mpls = parseMpls(await readWhole(source, 'BDMV/PLAYLIST/00000.MPLS'));
  return { source, timeline: new Timeline(mpls.playItems), clips: await loadClips(source, ['00001', '00002']), videoPid: VIDEO_PID, audioPid: AUDIO_PID };
}

interface Collected {
  video: PipelineUnit[];
  audio: PipelineUnit[];
  ended: number;
  errors: unknown[];
}

function run(
  config: PipelineConfig,
  fromUs: number,
  isFull: (got: Collected) => boolean = () => false,
): { pipeline: PlaybackPipeline; got: Collected; done: Promise<void> } {
  const got: Collected = { video: [], audio: [], ended: 0, errors: [] };
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const pipeline = new PlaybackPipeline(config, {
    video: (u) => got.video.push(u),
    audio: (u) => got.audio.push(u),
    isFull: () => isFull(got),
    ended: () => {
      got.ended++;
      finish();
    },
    failed: (err) => {
      got.errors.push(err);
      finish();
    },
  });
  pipeline.start(fromUs);
  return { pipeline, got, done };
}

describe('PlaybackPipeline', () => {
  it('reads both play items in order on one continuous timeline', async () => {
    const { got, done } = run(await setup(), 0);
    await done;
    expect(got.ended).toBe(1);
    expect(got.video).toHaveLength(192);
    const times = got.video.map((u) => u.ptsUs);
    expect(times[0]).toBe(0);
    expect(times[96]).toBe(4_000_000);
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    expect(got.video.every((u) => u.inRange)).toBe(true);
    expect(got.audio.length).toBeGreaterThan(1500);
  });

  it('starts from the keyframe before a seek target inside the second item', async () => {
    const { got, done } = run(await setup(), 5_500_000);
    await done;
    expect(got.video[0].ptsUs).toBe(5_000_000);
    expect(got.video.every((u) => u.ptsUs >= 5_000_000)).toBe(true);
  });

  it('waits while the sinks are full and stops cleanly', async () => {
    let blocking = true;
    // Each clip fits in one 2 MB read, so blocking after the first batch pauses between play items.
    const { pipeline, got } = run(await setup(), 0, (g) => blocking && g.video.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    const paused = got.video.length;
    expect(paused).toBeGreaterThan(0);
    expect(paused).toBeLessThan(192);
    expect(got.ended).toBe(0);
    pipeline.stop();
    blocking = false;
    await new Promise((r) => setTimeout(r, 30));
    expect(got.video.length).toBe(paused);
    expect(got.ended).toBe(0);
  });

  it('reports a missing clip through failed()', async () => {
    const config = await setup();
    const first = config.clips.get('00001');
    if (!first) throw new Error('fixture is missing clip 00001');
    const { got, done } = run({ ...config, clips: new Map([['00001', first]]) }, 5_000_000);
    await done;
    expect(got.errors[0]).toBeInstanceOf(DiscError);
  });
});
