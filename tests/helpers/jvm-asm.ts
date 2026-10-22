/** Test support for the BD-J JVM: a minimal class-file assembler and a virtual clock. */

export type Const =
  | readonly ['utf8', string] | readonly ['class', string] | readonly ['int', number] | readonly ['float', number]
  | readonly ['long', bigint] | readonly ['double', number] | readonly ['string', string]
  | readonly ['field' | 'method' | 'imethod', string, string, string]
  | readonly ['mtype', string]
  | readonly ['mhandle', number, readonly ['field' | 'method' | 'imethod', string, string, string]]
  /** invokedynamic: index into `bootstrapMethods`, name, descriptor. */
  | readonly ['indy', number, string, string];

export interface AsmClassOptions {
  readonly access?: number;
  readonly interfaces?: readonly string[];
  readonly instanceFields?: readonly [string, string][];
  readonly bootstrapMethods?: readonly { readonly ref: Const; readonly args: readonly Const[] }[];
}

export interface AsmMethod {
  readonly name: string;
  readonly desc: string;
  /** Bytecode; a `{ c: Const }` entry becomes its 2-byte constant-pool index. Absent for a native or abstract method. */
  readonly code?: readonly (number | { readonly c: Const })[];
  /** Defaults to public static (0x0009); ACC_NATIVE is added when there is no code. */
  readonly access?: number;
  readonly maxStack?: number;
  readonly maxLocals?: number;
  readonly handlers?: readonly (readonly [start: number, end: number, handler: number, type: string | null])[];
}

export const ACC_PUBLIC_STATIC = 0x0009;
export const ACC_SYNCHRONIZED = 0x0020;
const ACC_NATIVE = 0x0100;

/** Emits a minimal class file (version 52, public, ACC_SUPER) with static fields and the given methods. */
export function assembleClass(
  name: string,
  methods: readonly AsmMethod[],
  staticFields: readonly [string, string][] = [],
  superName = 'java/lang/Object',
  opts: AsmClassOptions = {},
): Uint8Array {
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
      case 'string': { const n = cp(['utf8', c[1]]); b.push(8); w2(n); break; }
      case 'mtype': { const n = cp(['utf8', c[1]]); b.push(16); w2(n); break; }
      case 'mhandle': { const r = cp(c[2]); b.push(15, c[1]); w2(r); break; }
      case 'indy': {
        const nn = cp(['utf8', c[2]]);
        const dd = cp(['utf8', c[3]]);
        pool.push([12, nn >> 8, nn & 0xff, dd >> 8, dd & 0xff]);
        const natIndex = next++;
        b.push(18); w2(c[1]); w2(natIndex);
        break;
      }
      default: {
        const cls = cp(['class', c[1]]);
        const nn = cp(['utf8', c[2]]);
        const dd = cp(['utf8', c[3]]);
        pool.push([12, nn >> 8, nn & 0xff, dd >> 8, dd & 0xff]);
        const natIndex = next++;
        b.push(c[0] === 'field' ? 9 : c[0] === 'method' ? 10 : 11); w2(cls); w2(natIndex);
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
    const code: number[] | null = m.code ? [] : null;
    for (const op of m.code ?? []) if (typeof op === 'number') code!.push(op & 0xff); else { const i = cp(op.c); code!.push(i >> 8, i & 0xff); }
    const handlers = (m.handlers ?? []).map(([s, e, h, t]) => [s, e, h, t === null ? 0 : cp(['class', t])] as const);
    const access = (m.access ?? ACC_PUBLIC_STATIC) | (code || (m.access ?? 0) & 0x0400 ? 0 : ACC_NATIVE);
    return { access, name: cp(['utf8', m.name]), desc: cp(['utf8', m.desc]), code, handlers, maxStack: m.maxStack ?? 8, maxLocals: m.maxLocals ?? 4 };
  });
  const fields = [
    ...staticFields.map(([n, d]) => [0x0009, cp(['utf8', n]), cp(['utf8', d])] as const),
    ...(opts.instanceFields ?? []).map(([n, d]) => [0x0001, cp(['utf8', n]), cp(['utf8', d])] as const),
  ];
  const interfaces = (opts.interfaces ?? []).map((i) => cp(['class', i]));
  const bsms = (opts.bootstrapMethods ?? []).map((b) => [cp(b.ref), ...b.args.map((a) => cp(a))]);
  const bsmName = bsms.length > 0 ? cp(['utf8', 'BootstrapMethods']) : 0;
  u4(0xcafebabe); u2(0); u2(52);
  u2(next);
  for (const e of pool) for (const b of e) u1(b);
  u2(opts.access ?? 0x21); u2(thisIndex); u2(superIndex);
  u2(interfaces.length); for (const i of interfaces) u2(i);
  u2(fields.length);
  for (const [a, n, d] of fields) { u2(a); u2(n); u2(d); u2(0); }
  u2(bodies.length);
  for (const m of bodies) {
    u2(m.access); u2(m.name); u2(m.desc);
    if (!m.code) { u2(0); continue; }
    u2(1);
    u2(codeName); u4(12 + m.code.length + 8 * m.handlers.length);
    u2(m.maxStack); u2(m.maxLocals); u4(m.code.length); for (const b of m.code) u1(b);
    u2(m.handlers.length);
    for (const h of m.handlers) for (const v of h) u2(v);
    u2(0);
  }
  if (bsms.length === 0) u2(0);
  else {
    u2(1);
    u2(bsmName); u4(2 + bsms.reduce((n, b) => n + 2 + 2 * b.length, 0));
    u2(bsms.length);
    for (const [ref, ...args] of bsms) { u2(ref!); u2(args.length); for (const a of args) u2(a); }
  }
  return new Uint8Array(out);
}

/**
 * `nowMs` and `setTimer` for a Jvm whose time moves only when the test advances it. A 0 ms timer (the scheduler's
 * yield between slices) runs on the real event loop.
 */
export class VirtualClock {
  now = 0;
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;

  readonly nowMs = (): number => this.now;

  readonly setTimer = (ms: number, fn: () => void): (() => void) => {
    if (ms <= 0) {
      const id = setTimeout(fn, 0);
      return () => clearTimeout(id);
    }
    const entry = { at: this.now + ms, seq: this.seq++, fn };
    this.timers.push(entry);
    return () => {
      this.timers = this.timers.filter((e) => e !== entry);
    };
  };

  get pending(): number {
    return this.timers.length;
  }

  /** Moves time forward by `ms`, firing every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter((e) => e.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((e) => e !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = end;
  }

  /**
   * The host sleeps for `ms`: the clock moves on and no timer fires; those that fell due fire at the wake, when
   * advance next runs (as Node's and browsers' timers do across a macOS sleep).
   */
  sleep(ms: number): void {
    this.now += ms;
    for (const e of this.timers) e.at = Math.max(e.at, this.now);
  }

  /** Moves time to the earliest pending timer and fires it. */
  advanceToNext(): void {
    const at = Math.min(...this.timers.map((e) => e.at));
    this.advance(at - this.now);
  }
}

interface Runnable {
  readonly threads: { run(signal?: AbortSignal): Promise<'idle' | 'deadlock' | 'aborted'> };
}

/** Runs the scheduler, advancing the virtual clock whenever every thread waits on time, until nothing is left. */
export async function runWithClock(jvm: Runnable, clock: VirtualClock, signal?: AbortSignal): Promise<'idle' | 'deadlock' | 'aborted'> {
  for (;;) {
    const r = await jvm.threads.run(signal);
    if (r !== 'idle' || clock.pending === 0) return r;
    clock.advanceToNext();
  }
}

/** A zip of stored entries (no compression), enough for a class loader to read. */
export function storedZip(entries: readonly (readonly [name: string, data: Uint8Array])[]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (d: Uint8Array): number => {
    let c = ~0;
    for (const b of d) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return ~c >>> 0;
  };
  const local: number[] = [];
  const central: number[] = [];
  const le = (out: number[], v: number, n: number): void => {
    for (let i = 0; i < n; i++) out.push((v >>> (8 * i)) & 0xff);
  };
  for (const [name, data] of entries) {
    const nb = new TextEncoder().encode(name);
    const offset = local.length;
    const c = crc(data);
    le(local, 0x04034b50, 4); le(local, 10, 2); le(local, 0, 2); le(local, 0, 2); le(local, 0, 4);
    le(local, c, 4); le(local, data.length, 4); le(local, data.length, 4); le(local, nb.length, 2); le(local, 0, 2);
    local.push(...nb, ...data);
    le(central, 0x02014b50, 4); le(central, 20, 2); le(central, 10, 2); le(central, 0, 2); le(central, 0, 2); le(central, 0, 4);
    le(central, c, 4); le(central, data.length, 4); le(central, data.length, 4); le(central, nb.length, 2);
    le(central, 0, 2); le(central, 0, 2); le(central, 0, 2); le(central, 0, 2); le(central, 0, 4); le(central, offset, 4);
    central.push(...nb);
  }
  const end: number[] = [];
  le(end, 0x06054b50, 4); le(end, 0, 4); le(end, entries.length, 2); le(end, entries.length, 2);
  le(end, central.length, 4); le(end, local.length, 4); le(end, 0, 2);
  return new Uint8Array([...local, ...central, ...end]);
}
