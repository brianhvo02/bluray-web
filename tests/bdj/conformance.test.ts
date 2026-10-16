import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Jvm } from '../../src/engine/bdj/jvm/jvm';
import { Vfs } from '../../src/engine/bdj/jvm/vfs';
import { ZipArchive } from '../../src/engine/bdj/jvm/zip';
import type { JObject, JValue } from '../../src/engine/bdj/jvm/values';

const file = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));

const RT = file('../../src/bdj-classlib/rt-bdj.jar');
const BOOT_JARS = [file('../../src/bdj-classlib/libbluray-j2se.jar'), file('../../src/bdj-classlib/libbluray-awt-j2se.jar'), RT, file('./conformance.jar')];

describe('Bare (before boot)', () => {
  const jvm = new Jvm({
    bootJars: BOOT_JARS,
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

describe('after JDK boot', () => {
  let out = '';
  let err = '';
  let jvm: Jvm;

  beforeAll(async () => {
    jvm = new Jvm({
      bootJars: BOOT_JARS,
      nowMs: () => Date.now(),
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      vfs: new Vfs({ disc: null, jdkLib: ZipArchive.open(RT), nowMs: () => Date.now() }),
      systemProperties: new Map([['awt.toolkit', 'java.awt.BDToolkit']]),
    });
    const start = performance.now();
    await jvm.boot();
    const ms = performance.now() - start;
    console.log(`JDK boot took ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);

  async function property(name: string): Promise<string | null> {
    const v = await jvm.callStatic('java/lang/System', 'getProperty', '(Ljava/lang/String;)Ljava/lang/String;', [jvm.heap.newString(name)]);
    return jvm.heap.jsString(v as JObject | null);
  }

  it('sets the system properties, with the runtime-supplied ones', async () => {
    expect(await property('java.home')).toBe('/jdk');
    expect(await property('java.io.tmpdir')).toBe('/tmp');
    expect(await property('file.encoding')).toBe('UTF-8');
    expect(await property('line.separator')).toBe('\n');
    expect(await property('awt.toolkit')).toBe('java.awt.BDToolkit');
  });

  it('runs on the main thread of the main thread group, as HotSpot creates them', async () => {
    const t = (await jvm.callStatic('java/lang/Thread', 'currentThread', '()Ljava/lang/Thread;')) as JObject;
    expect(t).toBe(jvm.mainThread);
    expect(jvm.heap.jsString(jvm.getField(t, 'name', 'Ljava/lang/String;') as JObject)).toBe('main');
    const group = jvm.getField(t, 'group', 'Ljava/lang/ThreadGroup;') as JObject;
    expect(jvm.heap.jsString(jvm.getField(group, 'name', 'Ljava/lang/String;') as JObject)).toBe('main');
    const parent = jvm.getField(group, 'parent', 'Ljava/lang/ThreadGroup;') as JObject;
    expect(jvm.heap.jsString(jvm.getField(parent, 'name', 'Ljava/lang/String;') as JObject)).toBe('system');
    expect(jvm.getField(t, 'threadStatus', 'I')).toBe(5);
  });

  async function runMain(name: string): Promise<string> {
    out = '';
    err = '';
    const loader = jvm.loader;
    const args: JValue = jvm.heap.newArray(loader.arrayOf(loader.loadBoot('java/lang/String')!), 0);
    try {
      await jvm.callStatic(`conformance/${name}`, 'main', '([Ljava/lang/String;)V', [args]);
    } catch (e) {
      throw new Error(`${(e as Error).message}\nstdout so far:\n${out}\nstderr:\n${err}`);
    }
    return out;
  }

  it.each(['Arith', 'Arrays', 'Exceptions', 'Init', 'Strings', 'Collections', 'Reflect', 'Threads'])(
    '%s prints what HotSpot prints',
    async (name) => {
      const expected = new TextDecoder().decode(file(`./conformance/${name}.out`));
      expect(await runMain(name)).toBe(expected);
    },
    60_000,
  );
});
