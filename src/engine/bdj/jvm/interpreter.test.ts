import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { execute } from './interpreter';
import { Jvm } from './jvm';

const jar = (rel: string): Uint8Array => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const BOOT = [
  jar('../../../bdj-classlib/libbluray-j2se.jar'),
  jar('../../../bdj-classlib/libbluray-awt-j2se.jar'),
  jar('../../../bdj-classlib/rt-bdj.jar'),
];

type Const =
  | readonly ['utf8', string] | readonly ['class', string] | readonly ['int', number] | readonly ['float', number]
  | readonly ['long', bigint] | readonly ['double', number] | readonly ['field' | 'method', string, string, string];

interface AsmMethod {
  readonly name: string;
  readonly desc: string;
  /** Bytecode; a `{ c: Const }` entry becomes its 2-byte constant-pool index. */
  readonly code: readonly (number | { readonly c: Const })[];
  readonly maxStack?: number;
  readonly maxLocals?: number;
  readonly handlers?: readonly (readonly [start: number, end: number, handler: number, type: string | null])[];
}

/** Emits a minimal class file (version 52, public, ACC_SUPER) with static fields and static methods. */
function assembleClass(name: string, methods: readonly AsmMethod[], staticFields: readonly [string, string][] = [], superName = 'java/lang/Object'): Uint8Array {
  const out: number[] = [];
  const u1 = (v: number): void => void out.push(v & 0xff);
  const u2 = (v: number): void => { u1(v >> 8); u1(v); };
  const u4 = (v: number): void => { u2(v >>> 16); u2(v); };
  const pool: number[][] = [];
  const keys = new Map<string, number>();
  let next = 1;
  const cp = (c: Const): number => {
    const key = JSON.stringify(c, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
    const hit = keys.get(key);
    if (hit !== undefined) return hit;
    const b: number[] = [];
    const w2 = (v: number): void => void b.push((v >> 8) & 0xff, v & 0xff);
    const dv = new DataView(new ArrayBuffer(8));
    switch (c[0]) {
      case 'utf8': { const s = new TextEncoder().encode(c[1]); b.push(1); w2(s.length); b.push(...s); break; }
      case 'class': { const n = cp(['utf8', c[1]]); b.push(7); w2(n); break; }
      case 'int': dv.setInt32(0, c[1]); b.push(3, ...new Uint8Array(dv.buffer, 0, 4)); break;
      case 'float': dv.setFloat32(0, c[1]); b.push(4, ...new Uint8Array(dv.buffer, 0, 4)); break;
      case 'long': dv.setBigInt64(0, c[1]); b.push(5, ...new Uint8Array(dv.buffer)); break;
      case 'double': dv.setFloat64(0, c[1]); b.push(6, ...new Uint8Array(dv.buffer)); break;
      default: {
        const cls = cp(['class', c[1]]);
        const nn = cp(['utf8', c[2]]);
        const dd = cp(['utf8', c[3]]);
        pool.push([12, nn >> 8, nn & 0xff, dd >> 8, dd & 0xff]);
        const natIndex = next++;
        b.push(c[0] === 'field' ? 9 : 10); w2(cls); w2(natIndex);
      }
    }
    pool.push(b);
    const index = next;
    next += c[0] === 'long' || c[0] === 'double' ? 2 : 1;
    keys.set(key, index);
    return index;
  };
  const thisIndex = cp(['class', name]);
  const superIndex = cp(['class', superName]);
  const codeName = cp(['utf8', 'Code']);
  const bodies = methods.map((m) => {
    const code: number[] = [];
    for (const op of m.code) if (typeof op === 'number') code.push(op & 0xff); else { const i = cp(op.c); code.push(i >> 8, i & 0xff); }
    const handlers = (m.handlers ?? []).map(([s, e, h, t]) => [s, e, h, t === null ? 0 : cp(['class', t])] as const);
    return { name: cp(['utf8', m.name]), desc: cp(['utf8', m.desc]), code, handlers, maxStack: m.maxStack ?? 8, maxLocals: m.maxLocals ?? 4 };
  });
  const fields = staticFields.map(([n, d]) => [cp(['utf8', n]), cp(['utf8', d])] as const);
  u4(0xcafebabe); u2(0); u2(52);
  u2(next);
  for (const e of pool) for (const b of e) u1(b);
  u2(0x21); u2(thisIndex); u2(superIndex); u2(0);
  u2(fields.length);
  for (const [n, d] of fields) { u2(0x0009); u2(n); u2(d); u2(0); }
  u2(bodies.length);
  for (const m of bodies) {
    u2(0x0009); u2(m.name); u2(m.desc); u2(1);
    u2(codeName); u4(12 + m.code.length + 8 * m.handlers.length);
    u2(m.maxStack); u2(m.maxLocals); u4(m.code.length); for (const b of m.code) u1(b);
    u2(m.handlers.length);
    for (const h of m.handlers) for (const v of h) u2(v);
    u2(0);
  }
  u2(0);
  return new Uint8Array(out);
}

const newJvm = (): Jvm => new Jvm({ bootJars: BOOT, nowMs: () => 0, setTimer: () => () => {}, stdout: () => {}, stderr: () => {} });

/** Defines a class `T` with one static method `m` and calls it. */
async function run1(desc: string, code: AsmMethod['code'], maxLocals?: number): Promise<unknown> {
  const jvm = newJvm();
  jvm.loader.define('T', assembleClass('T', [{ name: 'm', desc, code, maxLocals }]), null, null);
  return jvm.callStatic('T', 'm', desc);
}

const ICONST_M1 = 0x02, ICONST_0 = 0x03, ICONST_1 = 0x04, FCONST_1 = 0x0c, BIPUSH = 0x10, LDC_W = 0x13, LDC2_W = 0x14;
const IDIV = 0x6c, LDIV = 0x6d, ISHL = 0x78, LUSHR = 0x7d, F2I = 0x8b, D2L = 0x8f, FCMPL = 0x95, FCMPG = 0x96;
const IADD = 0x60, POP = 0x57, DUP = 0x59, IRETURN = 0xac, LRETURN = 0xad, RETURN = 0xb1, ATHROW = 0xbf;
const GETSTATIC = 0xb2, PUTSTATIC = 0xb3, INVOKESPECIAL = 0xb7, INVOKESTATIC = 0xb8, NEW = 0xbb;

describe('interpreter arithmetic (Review Focus 5)', () => {
  it('idiv by zero throws ArithmeticException', async () => {
    await expect(run1('()I', [ICONST_1, ICONST_0, IDIV, IRETURN])).rejects.toThrow('java.lang.ArithmeticException: / by zero');
  });
  it('Integer.MIN_VALUE / -1 wraps', async () => {
    expect(await run1('()I', [LDC_W, { c: ['int', -2147483648] }, ICONST_M1, IDIV, IRETURN])).toBe(-2147483648);
  });
  it('Long.MIN_VALUE / -1L wraps', async () => {
    expect(await run1('()J', [LDC2_W, { c: ['long', -(2n ** 63n)] }, LDC2_W, { c: ['long', -1n] }, LDIV, LRETURN])).toBe(-(2n ** 63n));
  });
  it('f2i saturates and maps NaN to 0', async () => {
    expect(await run1('()I', [LDC_W, { c: ['float', NaN] }, F2I, IRETURN])).toBe(0);
    expect(await run1('()I', [LDC_W, { c: ['float', 1e20] }, F2I, IRETURN])).toBe(2147483647);
  });
  it('d2l of -1e30 is Long.MIN_VALUE', async () => {
    expect(await run1('()J', [LDC2_W, { c: ['double', -1e30] }, D2L, LRETURN])).toBe(-(2n ** 63n));
  });
  it('shifts mask the distance', async () => {
    expect(await run1('()I', [ICONST_1, BIPUSH, 33, ISHL, IRETURN])).toBe(2);
    expect(await run1('()J', [LDC2_W, { c: ['long', -1n] }, BIPUSH, 60, LUSHR, LRETURN])).toBe(15n);
  });
  it('fcmpl and fcmpg differ on NaN', async () => {
    expect(await run1('()I', [LDC_W, { c: ['float', NaN] }, FCONST_1, FCMPL, IRETURN])).toBe(-1);
    expect(await run1('()I', [LDC_W, { c: ['float', NaN] }, FCONST_1, FCMPG, IRETURN])).toBe(1);
  });
});

describe('stack overflow (Review Focus 2)', () => {
  const depth = { c: ['field', 'R', 'depth', 'I'] } as const;
  const self = { c: ['method', 'R', 'r', '()V'] } as const;
  const cls = (): Uint8Array => assembleClass('R', [
    { name: 'r', desc: '()V', code: [GETSTATIC, depth, ICONST_1, IADD, PUTSTATIC, depth, INVOKESTATIC, self, RETURN] },
    { name: 'depth', desc: '()I', code: [GETSTATIC, depth, IRETURN] },
    { name: 'caught', desc: '()I', code: [INVOKESTATIC, self, ICONST_0, IRETURN, POP, ICONST_1, IRETURN], handlers: [[0, 3, 5, 'java/lang/StackOverflowError']] },
  ], [['depth', 'I']]);

  it('ends the thread with StackOverflowError at depth 4,000', async () => {
    const jvm = newJvm();
    jvm.loader.define('R', cls(), null, null);
    await expect(jvm.callStatic('R', 'r', '()V')).rejects.toThrow(/^java\.lang\.StackOverflowError$/);
    expect(await jvm.callStatic('R', 'depth', '()I')).toBe(4000);
  });
  it('is catchable in Java', async () => {
    const jvm = newJvm();
    jvm.loader.define('R', cls(), null, null);
    expect(await jvm.callStatic('R', 'caught', '()I')).toBe(1);
  });
});

describe('failing class initialiser (Review Focus 4)', () => {
  it('throws ExceptionInInitializerError once, then NoClassDefFoundError, and the class is erroneous', async () => {
    const jvm = newJvm();
    const rte = 'java/lang/RuntimeException';
    jvm.loader.define('Bad', assembleClass('Bad', [
      { name: '<clinit>', desc: '()V', code: [NEW, { c: ['class', rte] }, DUP, INVOKESPECIAL, { c: ['method', rte, '<init>', '()V'] }, ATHROW] },
    ], [['x', 'I']]), null, null);
    jvm.loader.define('U', assembleClass('U', [{ name: 'get', desc: '()I', code: [GETSTATIC, { c: ['field', 'Bad', 'x', 'I'] }, IRETURN] }]), null, null);
    await expect(jvm.callStatic('U', 'get', '()I')).rejects.toThrow(/^java\.lang\.ExceptionInInitializerError$/);
    await expect(jvm.callStatic('U', 'get', '()I')).rejects.toThrow('java.lang.NoClassDefFoundError: Could not initialize class Bad');
    expect(jvm.loader.loadBoot('Bad')?.state).toBe('erroneous');
  });
});

describe('class initialisation order (JVM §5.5)', () => {
  it('marks the class initialising before its superclass, so the superclass sees its default statics', async () => {
    const jvm = newJvm();
    const px = { c: ['field', 'P', 'x', 'I'] } as const;
    const cy = { c: ['field', 'C', 'y', 'I'] } as const;
    jvm.loader.define('P', assembleClass('P', [
      { name: '<clinit>', desc: '()V', code: [GETSTATIC, cy, PUTSTATIC, px, RETURN] },
      { name: 'x', desc: '()I', code: [GETSTATIC, px, IRETURN] },
    ], [['x', 'I']]), null, null);
    jvm.loader.define('C', assembleClass('C', [
      { name: '<clinit>', desc: '()V', code: [BIPUSH, 5, PUTSTATIC, cy, RETURN] },
      { name: 'y', desc: '()I', code: [GETSTATIC, cy, IRETURN] },
    ], [['y', 'I']], 'P'), null, null);
    expect(await jvm.callStatic('C', 'y', '()I')).toBe(5);
    expect(await jvm.callStatic('P', 'x', '()I')).toBe(0);
  });
});

describe('conversions', () => {
  it('l2f rounds once, not through double', async () => {
    const L2F = 0x89, FRETURN = 0xae;
    expect(await run1('()F', [LDC2_W, { c: ['long', 2n ** 60n + 2n ** 36n + 1n] }, L2F, FRETURN])).toBe(2 ** 60 + 2 ** 37);
  });
});

describe('time slice', () => {
  it('execute returns budget on a spinning thread and keeps its place', () => {
    const jvm = newJvm();
    jvm.loader.define('S', assembleClass('S', [{ name: 'spin', desc: '()V', code: [0xa7, 0, 0] }]), null, null);
    const t = jvm.threads.spawn(null, jvm.loader.loadBoot('S')!.methods.get('spin()V')!, []);
    expect(execute(jvm, t, 1000)).toBe('budget');
    expect(t.frames.length).toBe(1);
    expect(t.frames[0]!.pc).toBe(0);
  });
});
