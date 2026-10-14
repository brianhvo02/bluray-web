import { describe, expect, it } from 'vitest';
import { compareTraces } from './compare';
import { parseTrace, type TraceEntry } from './format';
import { parseScript } from './script';

const base: TraceEntry[] = [
  { k: 'psr', i: 4, v: 65535 },
  { k: 'gpr', i: 0, v: 1 },
  { k: 'step', n: 0 },
  { k: 'gpr', i: 1, v: 2 },
  { k: 'step', n: 1 },
  { k: 'end', why: 'eof' },
];

describe('compareTraces', () => {
  it('accepts equal traces and ignores times', () => {
    const timed: TraceEntry[] = base.map((e, i) => (e.k === 'gpr' || e.k === 'psr' ? { ...e, t: i * 7 } : e));
    expect(() => compareTraces(base, timed)).not.toThrow();
  });

  it('names the step and shows both sides when a value differs', () => {
    const ours: TraceEntry[] = base.map((e) => (e.k === 'gpr' && e.i === 1 ? { ...e, v: 3 } : e));
    expect(() => compareTraces(base, ours)).toThrow(/entry 3, during script step 1[\s\S]*libbluray:[\s\S]*"v":2[\s\S]*ours:[\s\S]*"v":3/);
  });

  it('reports a trace that ends early or runs on', () => {
    expect(() => compareTraces(base, base.slice(0, 4))).toThrow(/entry 4/);
    expect(() => compareTraces(base.slice(0, 4), base)).toThrow(/entry 4/);
  });

  it('shows five entries of context on each side', () => {
    const long: TraceEntry[] = Array.from({ length: 30 }, (_, i): TraceEntry => ({ k: 'gpr', i: 0, v: i }));
    const ours: TraceEntry[] = long.map((e, i): TraceEntry => (i === 15 ? { k: 'gpr', i: 0, v: 99 } : e));
    const message = (() => {
      try {
        compareTraces(long, ours);
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    expect(message.split('\n').filter((l) => /^\s*\d+\s/.test(l.replace(/^(>>|  )/, '')))).toHaveLength(22);
  });
});

describe('parseTrace and parseScript', () => {
  it('parses JSON lines and skips blank lines', () => {
    expect(parseTrace('{"k":"gpr","i":1,"v":2}\n\n{"k":"end","why":"eof"}\n')).toEqual([{ k: 'gpr', i: 1, v: 2 }, { k: 'end', why: 'eof' }]);
  });

  it('parses every script step and ignores comments', () => {
    const steps = parseScript(['# boot', 'wait title 2', 'wait end', 'key ok  # select', 'key 7', 'mouse 10 20', 'click 30 40', 'play title 3', 'wait menu'].join('\n'));
    expect(steps).toEqual([
      { op: 'wait', what: 'title', n: 2 },
      { op: 'wait', what: 'end' },
      { op: 'key', key: 'ok' },
      { op: 'key', key: '7' },
      { op: 'mouse', x: 10, y: 20 },
      { op: 'click', x: 30, y: 40 },
      { op: 'play', title: 3 },
      { op: 'wait', what: 'menu' },
    ]);
  });

  it('rejects unknown steps with the line number', () => {
    expect(() => parseScript('wait end\nkey purple')).toThrow(/line 2/);
    expect(() => parseScript('wait title')).toThrow(/line 1/);
  });
});
