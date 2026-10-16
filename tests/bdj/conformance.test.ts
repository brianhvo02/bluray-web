import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Jvm } from '../../src/engine/bdj/jvm/jvm';
import { Vfs } from '../../src/engine/bdj/jvm/vfs';
import { ZipArchive } from '../../src/engine/bdj/jvm/zip';
import type { JObject, JValue } from '../../src/engine/bdj/jvm/values';
import { assembleClass } from '../helpers/jvm-asm';

const file = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));

const RT = file('../../src/bdj-classlib/rt-bdj.jar');
const BOOT_JARS = [file('../../src/bdj-classlib/libbluray-j2se.jar'), file('../../src/bdj-classlib/libbluray-awt-j2se.jar'), RT, file('./conformance.jar')];

const NEW = 0xbb, DUP = 0x59, INVOKESPECIAL = 0xb7, INVOKEVIRTUAL = 0xb6, INVOKESTATIC = 0xb8, RETURN = 0xb1, ARETURN = 0xb0;
const ALOAD_0 = 0x2a, ASTORE_0 = 0x4b, ICONST_0 = 0x03, ICONST_1 = 0x04, ICONST_5 = 0x08, NEWARRAY = 0xbc, ACONST_NULL = 0x01, AALOAD = 0x32;
const T_INT = 10;
const GETSTATIC = 0xb2, ISTORE_1 = 0x3c, ILOAD_1 = 0x1b, IFLE = 0x9e, IINC = 0x84, GOTO = 0xa7;
const ACC_PUBLIC = 0x0001;

function bootedJvm(stdout: (s: string) => void = () => {}, stderr: (s: string) => void = () => {}, bootJars = BOOT_JARS): Jvm {
  return new Jvm({
    bootJars,
    nowMs: () => Date.now(),
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    stdout,
    stderr,
    vfs: new Vfs({ disc: null, jdkLib: ZipArchive.open(RT), nowMs: () => Date.now() }),
    systemProperties: new Map([['awt.toolkit', 'java.awt.BDToolkit']]),
  });
}

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
    jvm = bootedJvm(
      (s) => (out += s),
      (s) => (err += s),
    );
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

  it('Thread.join wakes however the joiner is preempted between isAlive and wait', async () => {
    const thread = (n: string, d: string): { c: ['method', string, string, string] } => ({ c: ['method', 'java/lang/Thread', n, d] });
    jvm.loader.define(
      'JoinT',
      assembleClass(
        'JoinT',
        [
          { name: '<init>', desc: '()V', access: ACC_PUBLIC, code: [ALOAD_0, INVOKESPECIAL, thread('<init>', '()V'), RETURN] },
          { name: 'run', desc: '()V', access: ACC_PUBLIC, code: [RETURN] },
          {
            name: 'go',
            desc: '()V',
            // t = new JoinT(); t.start(); for (int i = n; i > 0; i--) {} t.join();
            code: [NEW, { c: ['class', 'JoinT'] }, DUP, INVOKESPECIAL, { c: ['method', 'JoinT', '<init>', '()V'] }, ASTORE_0, ALOAD_0,
              INVOKEVIRTUAL, thread('start', '()V'),
              GETSTATIC, { c: ['field', 'JoinT', 'n', 'I'] }, ISTORE_1, ILOAD_1, IFLE, 0, 9, IINC, 1, 0xff, GOTO, 0xff, 0xf9,
              ALOAD_0, INVOKEVIRTUAL, thread('join', '()V'), RETURN],
          },
        ],
        [['n', 'I']],
        'java/lang/Thread',
      ),
      null,
      null,
    );
    const cls = jvm.loader.loadBoot('JoinT')!;
    const n = cls.declaredField('n', 'I')!.slot;
    try {
      for (let slice = 1; slice <= 12; slice++) {
        for (let spin = 0; spin <= 80; spin++) {
          jvm.threads.slice = slice;
          cls.staticValues[n] = spin;
          await jvm.callStatic('JoinT', 'go', '()V');
        }
      }
    } finally {
      jvm.threads.slice = 10_000;
    }
  }, 60_000);

  it('puts a native method that throws at the top of the stack trace, as (Native Method)', async () => {
    jvm.loader.define(
      'NativeTop',
      assembleClass('NativeTop', [
        {
          name: 'copy',
          desc: '()Ljava/lang/Throwable;',
          code: [ICONST_1, NEWARRAY, T_INT, ICONST_0, ICONST_1, NEWARRAY, T_INT, ICONST_0, ICONST_5,
            INVOKESTATIC, { c: ['method', 'java/lang/System', 'arraycopy', '(Ljava/lang/Object;ILjava/lang/Object;II)V'] }, ACONST_NULL, ARETURN, ARETURN],
          handlers: [[0, 12, 14, 'java/lang/ArrayIndexOutOfBoundsException']],
        },
        {
          name: 'top',
          desc: '(Ljava/lang/Throwable;)Ljava/lang/StackTraceElement;',
          code: [ALOAD_0, INVOKEVIRTUAL, { c: ['method', 'java/lang/Throwable', 'getStackTrace', '()[Ljava/lang/StackTraceElement;'] }, ICONST_0, AALOAD, ARETURN],
        },
      ]),
      null,
      null,
    );
    const e = (await jvm.callStatic('NativeTop', 'copy', '()Ljava/lang/Throwable;')) as JObject;
    expect(e.cls.name).toBe('java/lang/ArrayIndexOutOfBoundsException');
    const top = (await jvm.callStatic('NativeTop', 'top', '(Ljava/lang/Throwable;)Ljava/lang/StackTraceElement;', [e])) as JObject;
    const text = (f: string): string | null => jvm.heap.jsString(jvm.getField(top, f, 'Ljava/lang/String;') as JObject | null);
    expect(text('declaringClass')).toBe('java.lang.System');
    expect(text('methodName')).toBe('arraycopy');
    expect(jvm.getField(top, 'lineNumber', 'I')).toBe(-2);
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

  it('java.time, which uses lambdas inside the JDK, adds days to a date', async () => {
    const LDC2_W = 0x14, SIPUSH = 0x11, BIPUSH = 0x10;
    const date = (n: string, d: string): { c: ['method', string, string, string] } => ({ c: ['method', 'java/time/LocalDate', n, d] });
    jvm.loader.define(
      'Dates',
      assembleClass('Dates', [
        {
          name: 'go',
          desc: '()Ljava/lang/String;',
          code: [SIPUSH, 0x07, 0xea, BIPUSH, 10, BIPUSH, 15, INVOKESTATIC, date('of', '(III)Ljava/time/LocalDate;'),
            LDC2_W, { c: ['long', 30n] }, INVOKEVIRTUAL, date('plusDays', '(J)Ljava/time/LocalDate;'),
            INVOKEVIRTUAL, date('toString', '()Ljava/lang/String;'), ARETURN],
        },
      ]),
      null,
      null,
    );
    const start = performance.now();
    const s = (await jvm.callStatic('Dates', 'go', '()Ljava/lang/String;')) as JObject;
    console.log(`LocalDate took ${(performance.now() - start).toFixed(0)} ms`);
    expect(jvm.heap.jsString(s)).toBe('2026-11-14');
  }, 60_000);
});

// HotSpot ran the programs on the JDK's class path alone. With libbluray's jars, opening a file goes through its
// FileInputStream, whose Logger takes over System.out; Lambdas opens one (String.format reads currency.data).
describe('on the JDK class path alone', () => {
  it('Lambdas prints what HotSpot prints', async () => {
    let out = '';
    const jvm = bootedJvm((s) => (out += s), () => {}, [RT, file('./conformance.jar')]);
    await jvm.boot();
    const loader = jvm.loader;
    const args: JValue = jvm.heap.newArray(loader.arrayOf(loader.loadBoot('java/lang/String')!), 0);
    const start = performance.now();
    await jvm.callStatic('conformance/Lambdas', 'main', '([Ljava/lang/String;)V', [args]);
    console.log(`Lambdas took ${(performance.now() - start).toFixed(0)} ms`);
    expect(out).toBe(new TextDecoder().decode(file('./conformance/Lambdas.out')));
  }, 60_000);
});

describe('Runtime.halt', () => {
  it('ends every thread at once and exposes the exit status', async () => {
    const jvm = bootedJvm();
    await jvm.boot();
    const start = performance.now();
    await jvm.callStatic('java/lang/Shutdown', 'halt', '(I)V', [3]);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(jvm.exitStatus).toBe(3);
    expect(jvm.threads.live).toEqual([]);
    expect(await jvm.threads.run()).toBe('idle');
  }, 30_000);
});
