import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ShownStill } from '../../src/engine/bdj/background';
import { createGraphicsPlane, planeHash } from '../../src/engine/bdj/graphics-plane';
import type { CompositorLike } from '../../src/engine/render/compositor';
import { compareBdjTraces } from './compare';
import { CONTROL_CALLS, parseBdjTrace } from './format';
import { parseKeyScript, type SettledStep } from './key-script';
import { replayPlayerBdj } from './replay-player';

const DISC = new URL('../../fixtures/synthetic/disc-bdj-menu', import.meta.url);

/**
 * libbluray's run of a key script on disc-bdj-menu (tools/bdj-trace/golden.sh, reduced by settled.py): the control
 * calls, each step with the settled plane's hash at its `wait still` steps, and the last flushed plane.
 */
function golden(script: string) {
  const text = readFileSync(new URL(`./golden/disc-bdj-menu.${script}.jsonl`, import.meta.url), 'utf8');
  const lines = text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    calls: parseBdjTrace(text),
    steps: lines.filter((l) => l.script === 'step') as unknown as SettledStep[],
    endHash: lines.find((l) => l.script === 'end')!.hash as string | null,
  };
}

/**
 * Replays the same script through the real Player and compares with libbluray: the control calls in order, and the
 * plane at every settled point. Flush by flush the runs differ legitimately: libbluray's BDRootWindow flushes on a 40 ms
 * timer, so whether a focus move's two repaints share a flush depends on timing, in libbluray's runs as in ours (Ruling
 * R3: settled points, not flush numbers).
 */
async function replayMenu(script: string, extra: Pick<Parameters<typeof replayPlayerBdj>[1], 'compositor' | 'decodeImage'> = {}) {
  const g = golden(script);
  const steps = parseKeyScript(readFileSync(new URL(`./scripts/disc-bdj-menu.${script}.keys`, import.meta.url), 'utf8'));
  const last = g.calls.at(-1)!;
  const run = await replayPlayerBdj(DISC, {
    until: last.call,
    occurrence: g.calls.filter((e) => e.call === last.call).length,
    script: steps,
    timeoutMs: 170_000,
    ...extra,
  });
  compareBdjTraces(g.calls, run.trace);
  // compareBdjTraces checks a prefix; the golden runs 5 s past the script, so it has every call, and ours none more
  const control = (t: typeof run.trace): number => t.filter((e) => CONTROL_CALLS.has(e.call)).length;
  expect(control(run.trace)).toBe(control(g.calls));
  expect(run.steps).toEqual(g.steps);
  expect(run.flushes.at(-1) ?? null).toBe(g.endHash);
  expect(run.events.some((e) => e.type === 'notice' && e.code === 'bdj-failed')).toBe(false);
  return { run, golden: g };
}

describe('BD-J menu disc against libbluray (disc-bdj-menu)', () => {
  it('arrows move the focus and Enter on Play starts playlist 00000, with the planes libbluray draws', async () => {
    // the menu's background still (HStillImageBackgroundConfiguration.displayImage, not in libbluray's plane: it leaves
    // displayImage unimplemented) goes to the compositor under the video
    const stills: ShownStill[] = [];
    const compositor: CompositorLike = {
      resize: () => undefined,
      drawVideo: () => undefined,
      setBackground: (still) => void (still && stills.push(still)),
      drawBdj: () => undefined,
      clearBdj: () => undefined,
    };
    const bitmap = { width: 64, height: 36, close: () => undefined } as unknown as ImageBitmap;
    const { run, golden: g } = await replayMenu('arrows', { compositor, decodeImage: async () => bitmap });
    expect(stills).toEqual([{ image: bitmap, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }]);
    // three settled menus (Play, Chapters, Extras focused), each with the logo and text in the disc's CFF font and in
    // the fallback font; Enter then plays 00000 behind an emptied plane
    expect(new Set(g.steps.flatMap((s) => (s.hash ? [s.hash] : []))).size).toBe(3);
    expect(run.trace.filter((e) => e.call === 'selectPlaylistN').map((e) => e.args[0])).toEqual([1, -1, 0]); // Enter stops and closes 00001 first
    expect(g.endHash).toBe(planeHash(createGraphicsPlane()));
    console.log(`disc-bdj-menu arrows: ${run.flushes.length} flushes (${run.flushes.join(' ')}), ${run.untilMs.toFixed(0)} ms`);
  }, 180_000);

  it('a click on the MouseListener button changes it, a click on empty plane changes nothing', async () => {
    const { run } = await replayMenu('mouse');
    console.log(`disc-bdj-menu mouse: ${run.flushes.length} flushes (${run.flushes.join(' ')}), ${run.untilMs.toFixed(0)} ms`);
  }, 180_000);
});
