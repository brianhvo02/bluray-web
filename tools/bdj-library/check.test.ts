import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '../../src/engine/bdj/host';
import { parseKeyScript } from '../../tests/bdj/key-script';
import { classify, discId, EMPTY_PLANE_HASH, missingClassesFromLog, parseLibblurayRun, type RunRecord, type RunStep } from './classify';

// Made-up runs of the generic script: playlist 7 behind the menu, ok starts playlist 8.
const sel = (pl: number, ret = 1): TraceEntry => ({ call: 'selectPlaylistN', args: [pl, -1, -1, '-1'], ret });
const reg = (n: number, v: number): TraceEntry => ({ call: 'writeRegN', args: [0, n, v, -1], ret: 0 });
const STEPS = ['wait menu 1500', 'key right', 'wait still 1000', 'key down', 'wait still 1000', 'key ok', 'wait playlist any'];
const CALLS = [sel(7), reg(1, 0), reg(1, 1), sel(8)];
/** The steps up to `count`, with the given settled hashes and the control-call count before each. */
function steps(hashes: readonly string[], callsBefore: readonly number[], count = STEPS.length): RunStep[] {
  let w = 0;
  return STEPS.slice(0, count).map((step, n) => ({ n, step, ...(step.startsWith('wait still') || step.startsWith('wait menu') ? { hash: hashes[w++] ?? null } : {}), calls: callsBefore[n]! }));
}
const BEFORE = [1, 1, 2, 2, 3, 3, 3];
function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    side: 'ours',
    end: 'done',
    endDetail: null,
    steps: steps(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], BEFORE),
    calls: CALLS,
    endHash: 'cccccccc',
    flushes: 9,
    missingClasses: [],
    rejectedPlaylists: [],
    wallMs: 1000,
    ...over,
  };
}
const lib = (over: Partial<RunRecord> = {}): RunRecord => run({ side: 'libbluray', ...over });
/** A run that never reached the menu: step 0 timed out with nothing drawn. */
const noMenu = (over: Partial<RunRecord> = {}): RunRecord => run({ end: 'timeout', steps: [], calls: [], endHash: null, flushes: 0, ...over });

describe('classify', () => {
  it('works: a visible menu, arrows change it, ok starts a playlist, and libbluray agrees', () => {
    expect(classify(run(), lib())).toEqual({ verdict: 'works', detail: 'same as libbluray' });
  });

  it('works when ok changes the title instead of the playlist', () => {
    const calls = [sel(7), reg(1, 0), reg(1, 1), { call: 'selectTitleN', args: [2], ret: 1 }];
    expect(classify(run({ calls }), lib({ calls })).verdict).toBe('works');
  });

  it('is not works when the arrows change nothing, ok starts nothing or the plane is empty', () => {
    const still = steps(['aaaaaaaa', 'aaaaaaaa', 'aaaaaaaa'], BEFORE);
    expect(classify(run({ steps: still }), lib()).verdict).not.toBe('works');
    const loop = [sel(7), reg(1, 0), reg(1, 1), sel(7)]; // the menu's own playlist again
    expect(classify(run({ calls: loop }), lib()).verdict).not.toBe('works');
    const empty = steps([EMPTY_PLANE_HASH, EMPTY_PLANE_HASH, EMPTY_PLANE_HASH], BEFORE);
    expect(classify(run({ steps: empty, endHash: EMPTY_PLANE_HASH }), lib({ steps: empty, endHash: EMPTY_PLANE_HASH })).verdict).not.toBe('works');
  });

  it('works when ok seeks to a chapter, and whatever the stub streams make each side loop', () => {
    const rate = (r: number): TraceEntry => ({ call: 'selectRateN', args: [r, 1], ret: 1 });
    const seek: TraceEntry = { call: 'seekN', args: [-1, 3, '-1'], ret: 1 };
    const ours = [sel(7), rate(0), reg(1, 0), reg(1, 1), reg(1, 1), seek, sel(8), sel(8), sel(8)];
    const theirs = [sel(7), reg(1, 0), sel(-1), rate(0), reg(1, 1), seek];
    const oursSteps = steps(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], [2, 2, 3, 3, 5, 5, 5]);
    const libSteps = steps(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], [1, 1, 2, 2, 5, 5, 6]);
    expect(classify(run({ calls: ours, steps: oursSteps }), lib({ calls: theirs, steps: libSteps }))).toEqual({ verdict: 'works', detail: 'same as libbluray' });
  });

  it('works when libbluray stopped early (stub) and its run is a prefix of ours', () => {
    const short = lib({ end: 'timeout', steps: steps(['aaaaaaaa', 'bbbbbbbb'], BEFORE, 4), calls: CALLS.slice(0, 3), endHash: 'bbbbbbbb' });
    expect(classify(run(), short)).toEqual({ verdict: 'works', detail: expect.stringMatching(/^libbluray stopped early \(stub\)/) });
  });

  it('libbluray-fails-too when neither run reaches the menu (step 1)', () => {
    expect(classify(noMenu(), lib({ end: 'timeout', steps: [], calls: [sel(7)], endHash: null })).verdict).toBe('libbluray-fails-too');
  });

  it('libbluray-fails-too only when libbluray fails on its own (error, no playlist, nothing drawn) and ours too', () => {
    expect(classify(noMenu(), lib({ end: 'error', steps: [], calls: [], endHash: null })).verdict).toBe('libbluray-fails-too');
    expect(classify(noMenu(), lib({ calls: [reg(1, 0)] })).detail).toMatch(/selects no playlist/);
    // libbluray did as well as ours, and both fall short: not libbluray's failure
    const still = steps(['aaaaaaaa', 'aaaaaaaa', 'aaaaaaaa'], BEFORE);
    expect(classify(run({ steps: still }), lib({ steps: still }))).toEqual({ verdict: 'stall', detail: expect.stringMatching(/^same as libbluray: arrows change nothing/) });
  });

  it('works when ours passes every step and libbluray, on stub streams, stops early or fails', () => {
    const differs = lib({ end: 'timeout', steps: steps(['dddddddd'], BEFORE, 2), calls: [sel(9)], endHash: 'dddddddd' });
    expect(classify(run(), differs)).toEqual({ verdict: 'works', detail: expect.stringMatching(/^libbluray stopped early \(stub\)/) });
    expect(classify(run(), lib({ end: 'killed', steps: [], calls: [], endHash: null })).verdict).toBe('works');
  });

  it('does not compare the hash of an animated menu step, only that it was visible', () => {
    const animated = (h: readonly string[]): RunStep[] => steps(h, BEFORE).map((x, i) => (i === 0 ? { n: 0, step: x.step, animated: true, calls: x.calls } : x));
    expect(classify(run({ steps: animated(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) }), lib({ steps: steps(['eeeeeeee', 'bbbbbbbb', 'cccccccc'], BEFORE) }))).toEqual({ verdict: 'works', detail: 'same as libbluray' });
  });

  it('missing-class with the class name, from the Java log', () => {
    const log = ['[bdj] Exception in thread "main" java.lang.NoClassDefFoundError: java/io/FileWriter', '  at com.example.Menu.save(Menu.java:12)', 'java.lang.ClassNotFoundException: com.example.Extra'];
    const missing = missingClassesFromLog(log);
    expect(missing).toEqual(['java.io.FileWriter']);
    expect(classify(noMenu({ missingClasses: missing }), lib())).toEqual({ verdict: 'missing-class', detail: 'java.io.FileWriter' });
    // ours to fix even where libbluray, with stub streams, gets no further
    const libNoMenu = lib({ end: 'timeout', steps: [], calls: [], endHash: null, flushes: 0 });
    expect(classify(noMenu({ missingClasses: missing }), libNoMenu)).toEqual({ verdict: 'missing-class', detail: 'java.io.FileWriter; libbluray (stub) also: draws nothing, stops at step 0 (timeout)' });
  });

  it('unsupported-video when selectPlaylist returned 0 on an MPEG-2 or VC-1 playlist', () => {
    const calls = [sel(3, 0)];
    expect(classify(noMenu({ calls, rejectedPlaylists: [{ playlist: 3, video: 'MPEG-2 video' }] }), lib())).toEqual({ verdict: 'unsupported-video', detail: 'playlist 3 (MPEG-2 video) refused' });
    expect(classify(noMenu({ calls, rejectedPlaylists: [{ playlist: 3, video: 'VC-1' }] }), lib()).verdict).toBe('unsupported-video');
    expect(classify(noMenu({ calls, rejectedPlaylists: [{ playlist: 3, video: 'H.264/AVC' }] }), lib()).verdict).not.toBe('unsupported-video');
  });

  it('stall when ours stops before libbluray does', () => {
    expect(classify(noMenu(), lib()).verdict).toBe('stall');
  });

  it('error when our run failed', () => {
    expect(classify(noMenu({ end: 'killed' }), lib())).toEqual({ verdict: 'error', detail: 'killed' });
  });

  it('diverges with the first differing step otherwise', () => {
    const other = steps(['aaaaaaaa', 'dddddddd', 'cccccccc'], BEFORE);
    expect(classify(run(), lib({ steps: other }))).toEqual({ verdict: 'diverges', detail: 'step 2 (wait still 1000): settled plane libbluray dddddddd, ours bbbbbbbb' });
    const calls = [sel(7), reg(1, 0), reg(1, 2), sel(8)];
    expect(classify(run(), lib({ calls })).detail).toBe('step 4 (wait still 1000): libbluray calls writeRegN(0,1,2,-1)=0, ours does not');
    const other8 = [sel(7), reg(1, 0), reg(1, 1), sel(9)];
    expect(classify(run(), lib({ calls: other8 })).detail).toMatch(/^after key ok: libbluray starts selectPlaylistN\(9/);
  });

  it('judges ours alone when libbluray was not run', () => {
    expect(classify(run(), null)).toEqual({ verdict: 'works', detail: 'not compared: no libbluray run' });
  });
});

describe('discId', () => {
  it('is 10 lowercase hex digits, never a path character', () => {
    for (const p of ['/library/Some Show (Extra)/Volume 1', '/library/名前/ディスク 2', '/a/b/../c']) {
      const id = discId(p);
      expect(id).toMatch(/^[0-9a-f]{10}$/);
      expect(id).not.toMatch(/[/\\. ]/);
    }
    expect(discId('/x')).toBe(discId('/x'));
    expect(discId('/x')).not.toBe(discId('/y'));
  });
});

describe('parseLibblurayRun', () => {
  it('reads the steps, settled hashes, control calls and end as settled.py does', () => {
    const out = [
      '{"call":"readRegN","args":[1,4],"ret":0}',
      '{"call":"selectPlaylistN","args":[7,-1,-1,"-1"],"ret":1}',
      '{"plane":"flush","n":1,"hash":"aaaaaaaa","t":10}',
      '{"script":"step","n":0,"step":"wait menu 1500","flushes":1,"t":20}',
      '{"script":"step","n":1,"step":"key right","flushes":1,"t":20}',
      '{"script":"end","why":"timeout","n":2,"text":"wait still 1000","flushes":1,"t":30}',
      '{"call":"selectPlaylistN","args":[0,-1,-1,"-1"],"ret":1}',
    ].join('\n');
    const r = parseLibblurayRun(out, 'bdj_trace: script step 2 "wait still 1000" did not hold within 60 s\n', 5);
    expect(r.end).toBe('timeout');
    expect(r.steps).toEqual([{ n: 0, step: 'wait menu 1500', hash: 'aaaaaaaa', calls: 1 }, { n: 1, step: 'key right', calls: 1 }]);
    const animated = parseLibblurayRun('{"script":"step","n":0,"step":"wait menu 1500","flushes":9,"animated":true,"t":20}\n', '', 5);
    expect(animated.steps).toEqual([{ n: 0, step: 'wait menu 1500', animated: true, calls: 0 }]);
    expect(r.calls).toEqual([sel(7)]);
    expect(r.endHash).toBe('aaaaaaaa');
    expect(r.endDetail).toMatch(/did not hold/);
  });
});

describe('generic.keys', () => {
  it('is the brief\'s script, with `wait menu` and `wait playlist any`', () => {
    const steps = parseKeyScript(readFileSync(new URL('./generic.keys', import.meta.url), 'utf8'));
    expect(steps.map((s) => s.text)).toEqual(STEPS);
    expect(steps[0]).toEqual({ kind: 'waitMenu', text: 'wait menu 1500', ms: 1500 });
    expect(steps.at(-1)).toEqual({ kind: 'waitPlaylist', text: 'wait playlist any', playlist: null });
  });
});
