import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatTrace, parseTrace, type TraceEvent } from './format';

const EVENT: TraceEvent = { t: 0, event: 0, layer: 0, box: [0, 1, 2, 3], lines: 1, clip: { rect: [0, 0, 1920, 1080], inverse: false }, runs: [] };

describe('trace format', () => {
  it('re-formats the committed golden byte for byte', () => {
    const text = readFileSync('tests/ass-trace/golden/basic.jsonl', 'utf8');
    expect(formatTrace(parseTrace(text))).toBe(text);
  });

  it('rounds numbers to 6 decimals, as the harness prints them (%.6f)', () => {
    expect(JSON.parse(formatTrace([EVENT])).box[0]).toBe(0);
    expect(JSON.parse(formatTrace([{ ...EVENT, box: [0.4140625, 1, 2, 3] }])).box[0]).toBe(0.414063);
    expect(JSON.parse(formatTrace([{ ...EVENT, box: [-0.0000001, 1, 2, 3] }])).box[0]).toBe(0);
  });

  it('writes one line per event, keys in a fixed order', () => {
    const text = formatTrace([EVENT, { ...EVENT, event: 1 }]);
    expect(text.split('\n')).toHaveLength(3); // two lines and the final newline
    expect(Object.keys(JSON.parse(text.split('\n')[0]!))).toEqual(['t', 'event', 'layer', 'box', 'lines', 'clip', 'runs']);
  });
});
