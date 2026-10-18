import { describe, expect, it } from 'vitest';
import { buildPlan, loadPlan, parseGateArgs, stats } from './gate';

const KEYS = ['wait playlist 149', 'wait still 1500   # menu', 'key right', 'wait still 1000', 'key ok', 'wait playlist 40'].join('\n');
const golden = (steps: Array<[string, string?]>, end = 'eeee'): string =>
  [
    '{"call":"setUOMaskN","args":[true,true],"ret":null}',
    ...steps.map(([step, hash], n) => JSON.stringify({ script: 'step', n, step, ...(hash ? { hash } : {}) })),
    JSON.stringify({ script: 'end', hash: end }),
  ].join('\n');

describe('buildPlan', () => {
  it('pairs the script with the settled hashes and stays before the last key, returning to the plane before it', () => {
    const plan = buildPlan(KEYS, golden([['wait playlist 149'], ['wait still 1500', 'aaaa'], ['key right'], ['wait still 1000', 'bbbb'], ['key ok'], ['wait playlist 40']]));
    expect(plan.steps.map((s) => s.hash)).toEqual([null, 'aaaa', null, 'bbbb', null, null]);
    expect(plan.stayBefore).toBe(4);
    expect(plan.stayHash).toBe('bbbb');
    expect(plan.endHash).toBe('eeee');
  });

  it('refuses a golden made from another script', () => {
    expect(() => buildPlan(KEYS, golden([['wait playlist 149'], ['wait still 1500', 'aaaa'], ['key left']]))).toThrow(/golden step 2/);
    expect(() => buildPlan('key ok', golden([['key ok'], ['wait playlist 40']]))).toThrow(/2 steps/);
  });

  it('loads the committed plans of both local discs', () => {
    const a = loadPlan('A_NEW_ERA');
    expect(a.stayHash).toBe('4bc306b4');
    expect(a.steps[a.stayBefore]!.step.text).toBe('key ok');
    const r = loadPlan('RENTAL_FAMILY');
    expect(r.steps.filter((s) => s.hash).map((s) => s.hash)).toEqual(['4055a182', 'b860e96b', '4521ddc5']);
    expect(r.stayHash).toBe('b860e96b');
  });
});

describe('parseGateArgs', () => {
  it('defaults to both discs, a 10-minute stay and port 4183', () => {
    const o = parseGateArgs(['--target', 'chrome']);
    expect(o.discs).toEqual(['A_NEW_ERA', 'RENTAL_FAMILY']);
    expect(o.stayMs).toBe(600_000);
    expect(o.port).toBe(4183);
    expect(o.server).toBeNull();
  });

  it('takes a shorter stay, flags and an external server', () => {
    const o = parseGateArgs(['--target', 'ios:00008', '--disc', 'RENTAL_FAMILY', '--stay-ms', '0', '--touch', '--server', 'https://192.168.1.2:8443/', '--token', 't']);
    expect(o).toMatchObject({ discs: ['RENTAL_FAMILY'], stayMs: 0, touch: true, server: 'https://192.168.1.2:8443', token: 't' });
  });

  it('rejects unknown discs and options, and a server without its token', () => {
    expect(() => parseGateArgs(['--target', 'chrome', '--disc', 'NOPE'])).toThrow(/no gate plan/);
    expect(() => parseGateArgs(['--target', 'chrome', '--bogus', '1'])).toThrow(/unknown option/);
    expect(() => parseGateArgs(['--target', 'chrome', '--server', 'http://x'])).toThrow(/go together/);
    expect(() => parseGateArgs([])).toThrow(/usage/);
  });
});

describe('stats', () => {
  it('gives median, min and max', () => {
    expect(stats([])).toBeNull();
    expect(stats([5, 1, 3])).toEqual({ n: 3, median: 3, max: 5, min: 1 });
    expect(stats([4, 1, 3, 2])).toEqual({ n: 4, median: 2.5, max: 4, min: 1 });
  });
});
