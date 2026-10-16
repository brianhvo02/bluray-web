import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Jvm } from '../../src/engine/bdj/jvm/jvm';

const file = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));

describe('Bare (before boot)', () => {
  const jvm = new Jvm({
    bootJars: [
      file('../../src/bdj-classlib/libbluray-j2se.jar'),
      file('../../src/bdj-classlib/libbluray-awt-j2se.jar'),
      file('../../src/bdj-classlib/rt-bdj.jar'),
      file('./conformance.jar'),
    ],
    nowMs: () => 0,
    setTimer: () => () => {},
    stdout: () => {},
    stderr: () => {},
  });
  const expected = new TextDecoder()
    .decode(file('./conformance/Bare.out'))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split(' ') as [string, string]);

  it.each(expected)('%s returns %s as on HotSpot', async (name, value) => {
    expect(await jvm.callStatic('conformance/Bare', name, '()I')).toBe(Number(value));
  });
});
