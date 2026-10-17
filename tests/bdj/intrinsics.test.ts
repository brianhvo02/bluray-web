/**
 * Each intrinsic and loop hook (src/engine/bdj/jvm/natives/intrinsics, and the class library's own in
 * src/bdj-classlib/intrinsics) against the Java it replaces: the same calls on
 * seeded random inputs, in a JVM with intrinsics off and one with them on, must leave the same arrays, fields, return
 * values and exceptions (class, message and stack trace).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { Invoke, setBytecodeProfile } from '../../src/engine/bdj/jvm/interpreter';
import type { BytecodeProfile } from '../../src/engine/bdj/jvm/interpreter';
import { Jvm } from '../../src/engine/bdj/jvm/jvm';
import type { StackTrace } from '../../src/engine/bdj/jvm/jvm';
import { JClass } from '../../src/engine/bdj/jvm/loader';
import { parseClassFile } from '../../src/engine/bdj/jvm/classfile';
import { Vfs } from '../../src/engine/bdj/jvm/vfs';
import { ZipArchive } from '../../src/engine/bdj/jvm/zip';
import type { JArray, JObject, JValue } from '../../src/engine/bdj/jvm/values';
import { assembleClass } from '../helpers/jvm-asm';
import { MAX_FRAMES } from '../../src/engine/bdj/jvm/interpreter';
import { registerClassLibraryIntrinsics } from '../../src/bdj-classlib/intrinsics/index';

const file = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const RT = file('../../src/bdj-classlib/rt-bdj.jar');
const BOOT_JARS = [file('../../src/bdj-classlib/libbluray-j2se.jar'), file('../../src/bdj-classlib/libbluray-awt-j2se.jar'), RT];

/** intrinsics: 'off', the engine's only, or with the class library's (as the BD-J worker runs). */
function newJvm(intrinsics: 'off' | 'engine' | 'all'): Jvm {
  return new Jvm({
    bootJars: BOOT_JARS,
    nowMs: () => 0,
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    stdout: () => {},
    stderr: () => {},
    vfs: new Vfs({ disc: null, jdkLib: ZipArchive.open(RT), nowMs: () => 0 }),
    systemProperties: new Map([['awt.toolkit', 'java.awt.BDToolkit']]),
    intrinsics: intrinsics !== 'off',
    ...(intrinsics === 'all' ? { extraIntrinsics: registerClassLibraryIntrinsics } : {}),
  });
}

/** mulberry32. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Outcome {
  readonly ret: JValue | undefined;
  /** Throwable.toString() and the stack, innermost first, as method@pc. */
  readonly thrown: string | null;
}

/** One side of the comparison: a booted JVM, with helpers to build objects and call methods in it. */
class Side {
  constructor(readonly jvm: Jvm) {}

  cls(name: string): JClass {
    return this.jvm.bootClass(name);
  }

  intArray(values: ArrayLike<number>): JArray {
    const a = this.jvm.heap.newArray(this.jvm.loader.arrayOf(this.jvm.loader.primitive('I')), values.length);
    (a.data as Int32Array).set(values);
    return a;
  }

  byteArray(values: ArrayLike<number>): JArray {
    const a = this.jvm.heap.newArray(this.jvm.loader.arrayOf(this.jvm.loader.primitive('B')), values.length);
    (a.data as Int8Array).set(values);
    return a;
  }

  /** A new object whose fields are set directly (no constructor runs). */
  object(cls: string, fields: Readonly<Record<string, readonly [desc: string, value: JValue]>> = {}): JObject {
    const o = this.jvm.heap.newObject(this.cls(cls));
    for (const [name, [desc, value]] of Object.entries(fields)) this.jvm.setField(o, name, desc, value);
    return o;
  }

  field(o: JObject, name: string, desc: string): JValue {
    return this.jvm.getField(o, name, desc);
  }

  /** Runs `cls.key` with `args` on a new thread (initialising `cls` first) until it ends. */
  async call(cls: string, key: string, args: readonly JValue[]): Promise<Outcome> {
    const c = this.cls(cls);
    const m = c.methods.get(key);
    if (!m) throw new Error(`${cls}.${key} is missing`);
    const jvm = this.jvm;
    const t = jvm.threads.spawnWith(jvm.mainThread, (t) =>
      jvm.withInit(t, c, () =>
        new Invoke(m, args, (ret) => {
          t.result = ret;
          return undefined;
        }),
      ),
    );
    const ended = new AbortController();
    t.onTerminate = () => ended.abort();
    let outcome = t.state === 'terminated' ? 'idle' : await jvm.threads.run(ended.signal);
    while (outcome === 'idle' && t.state !== 'terminated' && jvm.threads.timersPending) {
      await jvm.threads.nextTimer();
      outcome = await jvm.threads.run(ended.signal);
    }
    t.onTerminate = null;
    if (t.state !== 'terminated') throw new Error(`${cls}.${key} did not finish (${outcome})`);
    if (!t.uncaught) return { ret: t.result, thrown: null };
    const trace = t.uncaught.nativeData as StackTrace;
    const where = trace.methods.map((m, i) => `${m.nativeKey}@${trace.pcs[i]}`);
    return { ret: undefined, thrown: [jvm.describe(t.uncaught), ...where].join('\n  ') };
  }

  /** A new instance through its constructor. */
  async construct(cls: string, desc: string, args: readonly JValue[]): Promise<JObject> {
    const o = this.jvm.heap.newObject(this.cls(cls));
    const r = await this.call(cls, `<init>${desc}`, [o, ...args]);
    if (r.thrown) throw new Error(r.thrown);
    return o;
  }
}

/** A Color whose getRGB() is overridden (to 0x12345678), which the drawSpanN intrinsics decline. */
const XOR_COLOR = assembleClass(
  'XorColor',
  [
    { name: '<init>', desc: '(I)V', access: 0x0001, code: [0x2a, 0x1b, 0xb7, { c: ['method', 'java/awt/Color', '<init>', '(I)V'] }, 0xb1] },
    { name: 'getRGB', desc: '()I', access: 0x0001, code: [0x13, { c: ['int', 0x12345678] }, 0xac] },
  ],
  [],
  'java/awt/Color',
);

/** Calls from bytecode (the interpreter's invoke path; Side.call starts methods through an Invoke). */
const CALLS = assembleClass('IntrinsicCalls', [
  {
    name: 'getRGB',
    desc: '(Ljava/awt/image/ColorModel;I)I',
    code: [0x2a, 0x1b, 0xb6, { c: ['method', 'java/awt/image/ColorModel', 'getRGB', '(I)I'] }, 0xac],
  },
]);

/** static int d(int n) { return n == 0 ? "x".hashCode() : d(n - 1); }: an intrinsic called at a chosen depth. */
const DEEP = assembleClass('Deep', [
  {
    name: 'd',
    desc: '(I)I',
    maxStack: 2,
    maxLocals: 1,
    code: [0x1a, 0x9a, 0, 10, 0x13, { c: ['string', 'x'] }, 0xb6, { c: ['method', 'java/lang/String', 'hashCode', '()I'] }, 0xac,
      0x1a, 0x04, 0x64, 0xb8, { c: ['method', 'Deep', 'd', '(I)I'] }, 0xac],
  },
]);

const sides: { off: Side; on: Side } = {} as { off: Side; on: Side };
let profile: BytecodeProfile;

beforeAll(async () => {
  const off = newJvm('off');
  const on = newJvm('all');
  await off.boot();
  await on.boot();
  for (const jvm of [off, on]) {
    jvm.loader.define('XorColor', XOR_COLOR, null, null);
    jvm.loader.define('IntrinsicCalls', CALLS, null, null);
    jvm.loader.define('Deep', DEEP, null, null);
  }
  sides.off = new Side(off);
  sides.on = new Side(on);
  profile = { bytecodes: new Map(), calls: new Map() };
  setBytecodeProfile(profile);
  return () => setBytecodeProfile(null);
}, 60_000);

/** Bytecodes a side's JVM (by default the one with intrinsics) has run in the method `key` (class.name+desc). */
function bytecodesIn(key: string, side: 'on' | 'off' = 'on'): number {
  let n = 0;
  const jvm = sides[side].jvm;
  for (const [m, count] of profile.bytecodes) if (`${m.cls.name}.${m.name}${m.desc}` === key && jvm.loader.loadBoot(m.cls.name) === m.cls) n += count;
  return n;
}

/** Both sides' results for the same case, built by `run` on each. */
async function both<T>(run: (s: Side) => Promise<T>): Promise<{ off: T; on: T }> {
  return { off: await run(sides.off), on: await run(sides.on) };
}

const pick = <T,>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const anyInt = (r: () => number): number => (r() * 4294967296) | 0;

/** A random ARGB pixel, its alpha often 0 or 255. */
const pixel = (r: () => number): number => {
  const a = pick(r, [0, 255, int(r, 1, 254)]);
  return ((a << 24) | int(r, 0, 0xffffff)) | 0;
};

describe('scope', () => {
  it("applies only to the class library's classes, not to a disc's class of the same name", () => {
    const jvm = sides.on.jvm;
    const bytes = assembleClass('sun/awt/image/PNGImageDecoder', [
      { name: 'update_crc', desc: '(I[BII)I', code: [0x03, 0xac] },
      { name: 'produceImage', desc: '()V', access: 0x0001, code: [0xb1] },
    ]);
    const object = jvm.bootClass('java/lang/Object');
    const cls = new JClass({
      name: 'sun/awt/image/PNGImageDecoder',
      file: parseClassFile(bytes),
      superClass: object,
      interfaces: [],
      loader: jvm.heap.newObject(object), // a disc's class loader
      protectionDomain: null,
      componentType: null,
      primitive: false,
      objectClass: object,
      intrinsics: jvm.natives.intrinsics,
      loopHooks: jvm.natives.loopHooks,
    });
    expect(cls.methods.get('update_crc(I[BII)I')!.intrinsic).toBeUndefined();
    expect(cls.methods.get('produceImage()V')!.loopHooks).toBeUndefined();
    const boot = jvm.bootClass('sun/awt/image/PNGImageDecoder');
    expect(boot.methods.get('update_crc(I[BII)I')!.intrinsic).toBeDefined();
    expect(boot.methods.get('produceImage()V')!.loopHooks).toBeDefined();
  });
});

describe('frame limit', () => {
  it('an intrinsic called at the frame limit throws StackOverflowError where the bytecode would', async () => {
    // d(n) calls hashCode from frame n + 1: at MAX_FRAMES frames the call overflows, one below it does not
    for (const n of [MAX_FRAMES - 2, MAX_FRAMES - 1]) {
      const res = await both((s) => s.call('Deep', 'd(I)I', [n]));
      expect(res.on, `n = ${n}`).toEqual(res.off);
      expect(res.off.thrown?.startsWith('java.lang.StackOverflowError') ?? false).toBe(n === MAX_FRAMES - 1);
    }
  });
});

describe('without the class library intrinsics', () => {
  it("the engine's drawSpanN declines without Rectangle.intersection, and the bytecode draws", async () => {
    const jvm = newJvm('engine');
    await jvm.boot();
    expect(jvm.natives.helpers.rectangleIntersection).toBeUndefined();
    expect(jvm.natives.helpers.pixelConverters.has('java/awt/image/DirectColorModel')).toBe(false);
    expect(jvm.bootClass('sun/awt/image/PNGImageDecoder').methods.get('produceImage()V')!.loopHooks).toBeUndefined();
    const s = new Side(jvm);
    await s.construct('java/awt/Rectangle', '()V', []);
    const buf = s.intArray([0, 0, 0, 0]);
    const g = s.object('java/awt/BDGraphicsBase', {
      width: ['I', 4],
      backBuffer: ['[I', buf],
      actualClip: ['Ljava/awt/Rectangle;', s.object('java/awt/Rectangle', { width: ['I', 4], height: ['I', 1] })],
      dirty: ['Ljava/awt/Area;', s.object('java/awt/Area', { x0: ['I', 0x7fffffff], y0: ['I', 0x7fffffff], x1: ['I', -1], y1: ['I', -1] })],
      composite: ['Ljava/awt/AlphaComposite;', (await s.call('java/awt/AlphaComposite', 'getInstance(IF)Ljava/awt/AlphaComposite;', [2, 1])).ret as JObject],
      xorColor: ['Ljava/awt/Color;', null],
    });
    expect(await s.call('java/awt/BDGraphicsBase', 'drawSpanN(IIII)V', [g, 1, 0, 2, 0x11223344])).toEqual({ ret: undefined, thrown: null });
    expect([...(buf.data as Int32Array)]).toEqual([0, 0x11223344, 0x11223344, 0]);
  });
});

describe('BDGraphicsBase.drawSpanN', () => {
  interface Graphics {
    readonly width: number;
    readonly height: number;
    readonly buf: readonly number[] | null;
    readonly clip: readonly [number, number, number, number] | null;
    readonly area: readonly [number, number, number, number];
    readonly composite: readonly [rule: number, alpha: number] | null;
    readonly xor: number | null;
    readonly xorSubclass: boolean;
  }

  function randomGraphics(r: () => number): Graphics {
    const width = int(r, 1, 40);
    const height = int(r, 1, 6);
    const buf = r() < 0.04 ? null : Array.from({ length: width * height - (r() < 0.1 ? int(r, 1, 5) : 0) }, () => pixel(r));
    const edge = (): number => pick(r, [0x7fffffff, -0x80000000, 0x7ffffff0]);
    const clip: Graphics['clip'] =
      r() < 0.03
        ? null
        : r() < 0.1
          ? [edge(), int(r, -5, 5), edge(), int(r, -5, 20)]
          : r() < 0.6
            ? [0, 0, width, height]
            : [int(r, -5, width), int(r, -2, height), int(r, -3, width + 5), int(r, -1, height + 2)];
    const area: Graphics['area'] = r() < 0.5 ? [0x7fffffff, 0x7fffffff, -1, -1] : [int(r, 0, 10), int(r, 0, 3), int(r, 0, 50), int(r, 0, 8)];
    const composite: Graphics['composite'] =
      r() < 0.03 ? null : [pick(r, [1, 2, 3, 3, 3, 2, int(r, 1, 12)]), pick(r, [1, 0.5, Math.fround(r()), Math.fround(r()), 0])];
    const xor = r() < 0.1 ? anyInt(r) : null;
    return { width, height, buf, clip, area, composite, xor, xorSubclass: xor !== null && r() < 0.3 };
  }

  /** A column or row, mostly inside the buffer. */
  const col = (r: () => number, g: Graphics): number => (r() < 0.7 ? int(r, 0, g.width - 1) : int(r, -6, g.width + 4));
  const row = (r: () => number, g: Graphics): number => (r() < 0.8 ? int(r, 0, g.height - 1) : int(r, -3, g.height + 3));

  async function build(s: Side, g: Graphics): Promise<JObject> {
    const rect = s.cls('java/awt/Rectangle');
    if (rect.state !== 'initialized') await s.construct('java/awt/Rectangle', '()V', []);
    const composite = g.composite ? ((await s.call('java/awt/AlphaComposite', 'getInstance(IF)Ljava/awt/AlphaComposite;', g.composite)).ret as JObject) : null;
    let xorColor: JObject | null = null;
    if (g.xor !== null) {
      xorColor = g.xorSubclass ? await s.construct('XorColor', '(I)V', [g.xor]) : await s.construct('java/awt/Color', '(IZ)V', [g.xor, 1]);
    }
    return s.object('java/awt/BDGraphicsBase', {
      width: ['I', g.width],
      backBuffer: ['[I', g.buf ? s.intArray(g.buf) : null],
      actualClip: ['Ljava/awt/Rectangle;', g.clip ? s.object('java/awt/Rectangle', { x: ['I', g.clip[0]], y: ['I', g.clip[1]], width: ['I', g.clip[2]], height: ['I', g.clip[3]] }) : null],
      dirty: ['Ljava/awt/Area;', s.object('java/awt/Area', { x0: ['I', g.area[0]], y0: ['I', g.area[1]], x1: ['I', g.area[2]], y1: ['I', g.area[3]] })],
      composite: ['Ljava/awt/AlphaComposite;', composite],
      xorColor: ['Ljava/awt/Color;', xorColor],
    });
  }

  /** Counts a case: thrown, or drew (changed a pixel), and whether the intrinsic ran it (no bytecode ran). */
  function tally(counts: { thrown: number; drawn: number; intrinsic: number }, g: Graphics, off: { out: Outcome; state: unknown }, intrinsic: boolean): void {
    if (off.out.thrown) counts.thrown++;
    const buf = (off.state as { buf: number[] | null }).buf;
    if (buf && g.buf && buf.some((v, k) => v !== g.buf![k])) {
      counts.drawn++;
      if (intrinsic) counts.intrinsic++;
    }
  }

  function state(s: Side, o: JObject): unknown {
    const buf = s.field(o, 'backBuffer', '[I') as JArray | null;
    const dirty = s.field(o, 'dirty', 'Ljava/awt/Area;') as JObject;
    return { buf: buf ? [...(buf.data as Int32Array)] : null, dirty: ['x0', 'y0', 'x1', 'y1'].map((f) => s.field(dirty, f, 'I')) };
  }

  it('one colour along a span: identical pixels, dirty area and exceptions', async () => {
    const key = 'java/awt/BDGraphicsBase.drawSpanN(IIII)V';
    const counts = { thrown: 0, drawn: 0, intrinsic: 0 };
    for (let i = 0; i < 400; i++) {
      const r = rng(1000 + i);
      const g = randomGraphics(r);
      const args = [col(r, g), row(r, g), pick(r, [int(r, -3, g.width + 6), int(r, 1, g.width), 1, 0x7fffffff]), pixel(r)];
      const before = bytecodesIn(key);
      const res = await both(async (s) => {
        const o = await build(s, g);
        const out = await s.call('java/awt/BDGraphicsBase', 'drawSpanN(IIII)V', [o, ...args]);
        return { out, state: state(s, o) };
      });
      expect(res.on, `case ${i}`).toEqual(res.off);
      tally(counts, g, res.off, bytecodesIn(key) === before);
    }
    // exceptions, drawing and declines all occur, and the intrinsic drew most of what was drawn
    expect(counts.thrown).toBeGreaterThan(5);
    expect(counts.drawn).toBeGreaterThan(100);
    expect(counts.intrinsic).toBeGreaterThan(counts.drawn * 0.7);
  });

  it('pixels along a span, flipped or not: identical pixels, dirty area and exceptions', async () => {
    const key = 'java/awt/BDGraphicsBase.drawSpanN(III[IIZ)V';
    const counts = { thrown: 0, drawn: 0, intrinsic: 0 };
    for (let i = 0; i < 400; i++) {
      const r = rng(5000 + i);
      const g = randomGraphics(r);
      const src = r() < 0.03 ? null : Array.from({ length: int(r, 0, 50) }, () => pixel(r));
      const length = pick(r, [int(r, -3, g.width + 6), int(r, 1, g.width), int(r, 1, g.width), 0x7fffffff]);
      const args = [col(r, g), row(r, g), length, pick(r, [int(r, -8, 30), int(r, 0, 10), 0]), int(r, 0, 1)];
      const before = bytecodesIn(key);
      const res = await both(async (s) => {
        const o = await build(s, g);
        const out = await s.call('java/awt/BDGraphicsBase', key.slice(key.indexOf('.') + 1), [o, args[0]!, args[1]!, args[2]!, src ? s.intArray(src) : null, args[3]!, args[4]!]);
        return { out, state: state(s, o) };
      });
      expect(res.on, `case ${i}`).toEqual(res.off);
      tally(counts, g, res.off, bytecodesIn(key) === before);
    }
    expect(counts.thrown).toBeGreaterThan(5);
    expect(counts.drawn).toBeGreaterThan(100);
    expect(counts.intrinsic).toBeGreaterThan(counts.drawn * 0.7);
  });
});

describe('BDRootWindow.isBackBufferClear', () => {
  it('returns what the Java loop returns, and throws where it throws', async () => {
    for (let i = 0; i < 200; i++) {
      const r = rng(9000 + i);
      const width = int(r, -2, 30);
      const height = int(r, -2, 10);
      const n = Math.max(0, width * height) + (r() < 0.2 ? int(r, -5, 5) : 0);
      const buf = r() < 0.05 ? null : Array.from({ length: Math.max(0, n) }, () => (r() < 0.02 ? anyInt(r) : 0));
      const res = await both(async (s) => {
        const o = s.object('java/awt/BDRootWindow', { width: ['I', width], height: ['I', height], backBuffer: ['[I', buf ? s.intArray(buf) : null] });
        return s.call('java/awt/BDRootWindow', 'isBackBufferClear()Z', [o]);
      });
      expect(res.on, `case ${i}`).toEqual(res.off);
    }
  });
});

describe('Arrays.fill(int[], int)', () => {
  it('fills as the Java loop does, and throws for null', async () => {
    for (let i = 0; i < 20; i++) {
      const r = rng(12000 + i);
      const a = i === 0 ? null : Array.from({ length: int(r, 0, 40) }, () => anyInt(r));
      const v = anyInt(r);
      const res = await both(async (s) => {
        const arr = a ? s.intArray(a) : null;
        const out = await s.call('java/util/Arrays', 'fill([II)V', [arr, v]);
        return { out, arr: arr ? [...(arr.data as Int32Array)] : null };
      });
      expect(res.on).toEqual(res.off);
    }
  });
});

describe('PNGImageDecoder.update_crc', () => {
  it('returns the Java CRC, and throws where Java throws', async () => {
    for (let i = 0; i < 200; i++) {
      const r = rng(13000 + i);
      const buf = r() < 0.05 ? null : Array.from({ length: int(r, 0, 64) }, () => int(r, -128, 127));
      const args = [anyInt(r), int(r, -3, 70), int(r, -3, 70)];
      const res = await both((s) => s.call('sun/awt/image/PNGImageDecoder', 'update_crc(I[BII)I', [args[0]!, buf ? s.byteArray(buf) : null, args[1]!, args[2]!]));
      expect(res.on, `case ${i}`).toEqual(res.off);
    }
  });
});

describe('DirectColorModel.getRGB(int)', () => {
  /** A contiguous mask of `bits` bits at `shift`. */
  const mask = (bits: number, shift: number): number => (bits === 0 ? 0 : (((2 ** bits - 1) * 2 ** shift) | 0));

  it('converts pixels as the Java getters do, sRGB with and without alpha, premultiplied or not', async () => {
    const key = 'java/awt/image/DirectColorModel.getRGB(I)I';
    const before = bytecodesIn(key);
    let models = 0;
    for (let i = 0; i < 60; i++) {
      const r = rng(15000 + i);
      const bits = [int(r, 1, 8), int(r, 1, 8), int(r, 1, 8), pick(r, [0, 8, int(r, 1, 8)])];
      const shifts = [24 - bits[0]!, 16 - bits[1]!, 8 - bits[2]!, 32 - bits[3]!];
      const masks = bits.map((b, k) => mask(b, shifts[k]!));
      const premultiplied = masks[3] !== 0 && r() < 0.5 ? 1 : 0;
      const pixels = Array.from({ length: 30 }, () => anyInt(r));
      const res = await both(async (s) => {
        let cm: JObject;
        try {
          if (premultiplied) {
            const cs = (await s.call('java/awt/color/ColorSpace', 'getInstance(I)Ljava/awt/color/ColorSpace;', [1000])).ret as JObject;
            cm = await s.construct('java/awt/image/DirectColorModel', '(Ljava/awt/color/ColorSpace;IIIIIZI)V', [cs, 32, masks[0]!, masks[1]!, masks[2]!, masks[3]!, 1, 3]);
          } else {
            cm = await s.construct('java/awt/image/DirectColorModel', '(IIIII)V', [32, masks[0]!, masks[1]!, masks[2]!, masks[3]!]);
          }
        } catch (e) {
          return { model: String(e), out: [] };
        }
        const out: Outcome[] = [];
        for (const p of pixels) {
          out.push(await s.call('java/awt/image/DirectColorModel', 'getRGB(I)I', [cm, p]));
          out.push(await s.call('IntrinsicCalls', 'getRGB(Ljava/awt/image/ColorModel;I)I', [cm, p]));
        }
        return { model: 'ok', out };
      });
      expect(res.on, `model ${i}`).toEqual(res.off);
      if (res.off.model === 'ok') models++;
    }
    expect(models).toBeGreaterThan(40);
    expect(bytecodesIn(key) - before).toBe(0);
  });
});

describe('SHA.implCompress0', () => {
  it('expands W and adds the block into state as the Java rounds do', async () => {
    const key = 'sun/security/provider/SHA.implCompress0([BI)V';
    for (let i = 0; i < 60; i++) {
      const r = rng(17000 + i);
      const w = Array.from({ length: i < 3 ? int(r, 70, 80) : 80 }, () => anyInt(r));
      const state = Array.from({ length: i === 3 ? 4 : 5 }, () => anyInt(r));
      const res = await both(async (s) => {
        const sha = await s.construct('sun/security/provider/SHA', '()V', []);
        const W = s.intArray(w);
        const st = s.intArray(state);
        s.jvm.setField(sha, 'W', '[I', W);
        s.jvm.setField(sha, 'state', '[I', st);
        const out = await s.call('sun/security/provider/SHA', 'implCompress0([BI)V', [sha, null, 0]);
        return { out, W: [...(W.data as Int32Array)], state: [...(st.data as Int32Array)] };
      });
      expect(res.on, `block ${i}`).toEqual(res.off);
    }
    // the four short-array cases ran the bytecode (and threw); the rest ran the intrinsic
    expect(bytecodesIn(key)).toBeLessThan(bytecodesIn(key, 'off') / 10);
  });
});

describe('BigInteger.implMulAdd', () => {
  it('multiply-accumulates words and returns the carry as the Java loop does, throwing where it throws', async () => {
    const key = 'java/math/BigInteger.implMulAdd([I[IIII)I';
    let intrinsic = 0;
    for (let i = 0; i < 300; i++) {
      const r = rng(19000 + i);
      const word = (): number => pick(r, [anyInt(r), anyInt(r), -1, 0, 1, -2147483648]);
      const out = r() < 0.02 ? null : Array.from({ length: int(r, 0, 12) }, word);
      const input = r() < 0.02 ? null : Array.from({ length: int(r, 0, 12) }, word);
      // mostly in range: offset counts from the end of out, len words of in
      const len = r() < 0.8 && input ? int(r, 0, input.length) : int(r, -1, 13);
      const offset = r() < 0.8 && out ? int(r, 0, Math.max(0, out.length - Math.max(len, 0))) : int(r, -2, 13);
      const args = [offset, len, word()];
      const before = bytecodesIn(key);
      const res = await both(async (s) => {
        const o = out ? s.intArray(out) : null;
        const ret = await s.call('java/math/BigInteger', 'implMulAdd([I[IIII)I', [o, input ? s.intArray(input) : null, args[0]!, args[1]!, args[2]!]);
        return { ret, out: o ? [...(o.data as Int32Array)] : null };
      });
      expect(res.on, `case ${i}`).toEqual(res.off);
      if (bytecodesIn(key) === before) intrinsic++;
    }
    expect(intrinsic).toBeGreaterThan(150);
  });
});

describe('String methods and the UTF-8 decoder', () => {
  /** A random string: ASCII mostly, sometimes Latin-1, BMP and surrogate chars. */
  const randomString = (r: () => number, max = 12): string =>
    Array.from({ length: int(r, 0, max) }, () => String.fromCharCode(pick(r, [int(r, 97, 100), int(r, 32, 126), int(r, 0x80, 0xff), int(r, 0x100, 0xd7ff), int(r, 0xd800, 0xdfff)]))).join('');

  it('hashCode, charAt, equals, indexOf, lastIndexOf and startsWith return what the Java code returns', async () => {
    const S = 'java/lang/String';
    for (let i = 0; i < 300; i++) {
      const r = rng(21000 + i);
      const a = randomString(r);
      const b = r() < 0.3 ? a : r() < 0.5 ? a.slice(0, int(r, 0, a.length)) : randomString(r);
      const ch = pick(r, [a.charCodeAt(int(r, 0, Math.max(0, a.length - 1))) || 97, int(r, 97, 100), -1, 0x10000 + int(r, 0, 0xfff), 0xffff]);
      const from = pick(r, [int(r, -3, a.length + 3), 0, -0x80000000, 0x7fffffff]);
      const at = int(r, -2, a.length + 1);
      const other = pick(r, ['b', 'a', null] as const);
      const prefix = r() < 0.05 ? null : 'b';
      const offset = pick(r, [0, int(r, -2, a.length + 2)]);
      const res = await both(async (s) => {
        const sa = s.jvm.heap.newString(a);
        const sb = s.jvm.heap.newString(b);
        const out: Outcome[] = [];
        out.push(await s.call(S, 'hashCode()I', [sa]));
        out.push(await s.call(S, 'hashCode()I', [sa])); // cached
        out.push(await s.call(S, 'charAt(I)C', [sa, at]));
        out.push(await s.call(S, 'equals(Ljava/lang/Object;)Z', [sa, other === 'b' ? sb : other === 'a' ? sa : null]));
        out.push(await s.call(S, 'equals(Ljava/lang/Object;)Z', [sa, s.jvm.mirror(s.cls(S))])); // not a String
        out.push(await s.call(S, 'indexOf(II)I', [sa, ch, from]));
        out.push(await s.call(S, 'lastIndexOf(II)I', [sa, ch, from]));
        out.push(await s.call(S, 'startsWith(Ljava/lang/String;I)Z', [sa, prefix === null ? null : sb, offset]));
        return { out, hash: s.field(sa, 'hash', 'I') };
      });
      expect(res.on, `case ${i}: ${JSON.stringify([a, b])}`).toEqual(res.off);
    }
  });

  it('UTF_8.Decoder.decode copies ASCII as the Java loops do, and leaves the rest to them', async () => {
    const key = 'sun/nio/cs/UTF_8$Decoder.decode([BII[C)I';
    let intrinsic = 0;
    for (let i = 0; i < 200; i++) {
      const r = rng(23000 + i);
      const bytes = Array.from({ length: int(r, 0, 24) }, () => (r() < 0.9 ? int(r, 0, 127) : int(r, -128, -1)));
      // the last cases: sp + len wraps past sp, so the bytecode reads (and throws) though len <= 0
      const wrap = i >= 195;
      const sp = wrap ? -2147483000 - i : r() < 0.8 ? int(r, 0, bytes.length) : int(r, -2, bytes.length + 2);
      const len = wrap ? -1000 : r() < 0.8 ? int(r, 0, Math.max(0, bytes.length - Math.max(sp, 0))) : int(r, -2, 30);
      const daLen = r() < 0.8 ? Math.max(len, 0) + int(r, 0, 3) : int(r, 0, 30);
      const before = bytecodesIn(key);
      const res = await both(async (s) => {
        const charset = (await s.call('java/nio/charset/Charset', 'forName(Ljava/lang/String;)Ljava/nio/charset/Charset;', [s.jvm.heap.newString('UTF-8')])).ret as JObject;
        const decoder = (await s.call(charset.cls.name, 'newDecoder()Ljava/nio/charset/CharsetDecoder;', [charset])).ret as JObject;
        const da = s.jvm.heap.newArray(s.jvm.loader.arrayOf(s.jvm.loader.primitive('C')), daLen);
        const out = await s.call('sun/nio/cs/UTF_8$Decoder', 'decode([BII[C)I', [decoder, s.byteArray(bytes), sp, len, da]);
        return { out, da: [...(da.data as Uint16Array)] };
      });
      expect(res.on, `case ${i}`).toEqual(res.off);
      if (bytecodesIn(key) === before) intrinsic++;
    }
    expect(intrinsic).toBeGreaterThan(60);
  });
});

/** A PNG of random filtered rows: crc and zlib from Node, the image data random bytes after each filter type byte. */
function randomPng(r: () => number, opts: { colorType: number; depth: number; interlace: boolean; trns: boolean }): Uint8Array {
  const width = int(r, 1, 64);
  const height = int(r, 1, 9);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[opts.colorType]!;
  const bpp = channels * opts.depth;
  const passes = opts.interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const raw: number[] = [];
  for (const [c0, r0, ci, ri] of passes) {
    const cols = Math.ceil((width - c0!) / ci!);
    if (cols <= 0) continue;
    for (let y = r0!; y < height; y += ri!) {
      raw.push(int(r, 0, 4));
      for (let k = 0; k < Math.ceil((cols * bpp) / 8); k++) raw.push(int(r, 0, 255));
    }
  }
  const chunks: Uint8Array[] = [];
  const chunk = (type: string, data: ArrayLike<number>): void => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    chunks.push(out);
  };
  chunk('IHDR', [...u32(width), ...u32(height), opts.depth, opts.colorType, 0, 0, opts.interlace ? 1 : 0]);
  if (opts.colorType === 3) chunk('PLTE', Array.from({ length: 3 * (1 << opts.depth) }, () => int(r, 0, 255)));
  if (opts.trns) {
    if (opts.colorType === 3) chunk('tRNS', Array.from({ length: int(r, 1, 1 << opts.depth) }, () => int(r, 0, 255)));
    else if (opts.colorType === 2) chunk('tRNS', Array.from({ length: 6 }, () => (opts.depth === 8 ? pick(r, [0, int(r, 0, 255)]) : int(r, 0, 255))));
    else if (opts.colorType === 0) chunk('tRNS', [0, int(r, 0, (1 << Math.min(opts.depth, 8)) - 1)]);
  }
  chunk('IDAT', deflateSync(Uint8Array.from(raw)));
  chunk('IEND', []);
  const total = chunks.reduce((n, c) => n + c.length, 8);
  const png = new Uint8Array(total);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8;
  for (const c of chunks) {
    png.set(c, at);
    at += c.length;
  }
  return png;
}

const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

describe('PNG decoding into an image (PNGImageDecoder.produceImage row loop, BDImageConsumer.setPixels)', () => {
  let files = 0;

  /** Decodes `png` the way libbluray's toolkit images do (FileImageSource into a BDImageConsumer), on this thread. */
  async function decode(s: Side, png: Uint8Array): Promise<unknown> {
    const path = `/tmp/intrinsics-${files++}.png`;
    const vfs = s.jvm.opts.vfs!;
    const h = vfs.open(path, 'w')!;
    vfs.write(h, png, 0, png.length);
    vfs.close(h);
    const src = await s.construct('sun/awt/image/FileImageSource', '(Ljava/lang/String;)V', [s.jvm.heap.newString(path)]);
    const image = await s.construct('java/awt/BDImageConsumer', '(Ljava/awt/image/ImageProducer;)V', [src]);
    s.jvm.setField(src, 'awaitingFetch', 'Z', 1); // fetch here, not on an ImageFetcher thread
    const added = await s.call('sun/awt/image/InputStreamImageSource', 'addConsumer(Ljava/awt/image/ImageConsumer;)V', [src, image]);
    const fetched = await s.call('sun/awt/image/InputStreamImageSource', 'doFetch()V', [src]);
    const buf = s.field(image, 'backBuffer', '[I') as JArray | null;
    return {
      added,
      fetched,
      width: s.field(image, 'width', 'I'),
      height: s.field(image, 'height', 'I'),
      status: s.field(image, 'status', 'I'),
      buf: buf ? [...(buf.data as Int32Array)] : null,
    };
  }

  // grey and palette images need IndexColorModel, which the trimmed class library leaves out: they fail alike
  const TYPES: readonly [colorType: number, depth: number][] = [
    [0, 1], [0, 2], [0, 4], [0, 8], [0, 16],
    [2, 8], [2, 16],
    [3, 1], [3, 2], [3, 4], [3, 8],
    [4, 8], [4, 16],
    [6, 8], [6, 16],
  ];

  it.each(TYPES)('colour type %i, %i bits: the same image, interlaced or not, with or without tRNS', async (colorType, depth) => {
    const key = 'sun/awt/image/PNGImageDecoder.produceImage()V';
    const before = [bytecodesIn(key), bytecodesIn(key, 'off')];
    let pixels = 0;
    for (let i = 0; i < 6; i++) {
      const r = rng(20000 + colorType * 100 + depth * 10 + i);
      const png = randomPng(r, { colorType, depth, interlace: i % 2 === 1, trns: i >= 2 && r() < 0.7 });
      const res = await both((s) => decode(s, png));
      expect(res.on, `image ${i}`).toEqual(res.off);
      const off = res.off as { buf: number[] | null; status: number };
      pixels += off.buf?.length ?? 0;
    }
    if (colorType === 0 || colorType === 3) return;
    expect(pixels).toBeGreaterThan(0);
    // the row loop ran in the hook: a fraction of the bytecode the Java loop ran
    expect(bytecodesIn(key) - before[0]!).toBeLessThan((bytecodesIn(key, 'off') - before[1]!) / 3);
  });

  it('a truncated PNG fails the same way', async () => {
    for (let i = 0; i < 6; i++) {
      const r = rng(30000 + i);
      const png = randomPng(r, { colorType: pick(r, [2, 6, 3]), depth: 8, interlace: r() < 0.5, trns: false });
      const cut = png.subarray(0, int(r, 40, png.length - 13));
      const res = await both((s) => decode(s, cut));
      expect(res.on, `image ${i}`).toEqual(res.off);
    }
  });
});
