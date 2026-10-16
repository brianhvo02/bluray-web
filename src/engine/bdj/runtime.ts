/*
 * The BD-J runtime: boots libbluray's Java stack on our JVM and passes it events. Ported from libbluray
 * src/libbluray/bdj/bdj.c (bdj_open, _create_jvm's properties and class path, _bdj_init, bdj_process_event,
 * bdj_close) and bluray.c (_start_bdj, _stop_bdj).
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2010-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ByteSource } from '../disc/byte-source';
import type { DiscModel } from '../disc/open-disc';
import { BdjError } from './errors';
import type { BdjErrorCode } from './errors';
import type { BdjHost, TraceEntry } from './host';
import { Jvm } from './jvm/jvm';
import { externalName } from './jvm/loader';
import type { JMethod } from './jvm/loader';
import { lineNumber } from './jvm/natives/lang';
import { registerLibblurayNatives } from './jvm/natives/libbluray';
import type { StackTrace } from './jvm/jvm';
import type { JThread } from './jvm/threads';
import { JavaThrowable } from './jvm/values';
import type { JObject, JValue } from './jvm/values';
import { Vfs } from './jvm/vfs';
import { ZipArchive } from './jvm/zip';

export interface ClassLibrarySource {
  readonly rt: Uint8Array;
  readonly libbluray: Uint8Array;
  readonly libblurayAwt: Uint8Array;
}

export interface BdjRuntimeDeps {
  /** The disc, with its normalised file list (FileSource.paths()) for the VFS. */
  readonly disc: ByteSource & { paths(): Iterable<string> };
  readonly model: DiscModel;
  readonly classLibrary: ClassLibrarySource;
  /** The runtime passes its own start, and a hook it uses to watch the host's trace. */
  readonly host: (startTitle: (title: number) => void, onTrace: (e: TraceEntry) => void) => BdjHost;
  readonly nowMs: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  readonly log: (line: string) => void;
}

export type RunOutcome = 'idle' | 'until' | 'aborted' | 'deadlock';

export const BdjEvent = {
  NONE: 0,
  START: 1,
  STOP: 2,
  PSR102: 3,
  PLAYLIST: 4,
  PLAYITEM: 5,
  CHAPTER: 6,
  MARK: 7,
  PTS: 8,
  END_OF_PLAYLIST: 9,
  SEEK: 10,
  RATE: 11,
  ANGLE: 12,
  AUDIO_STREAM: 13,
  SUBTITLE: 14,
  SECONDARY_STREAM: 15,
  VK_KEY: 16,
  UO_MASKED: 17,
  MOUSE: 18,
} as const;

const EVENT_NAMES = Object.keys(BdjEvent);
const BDJ_EVENT_LAST = BdjEvent.MOUSE;
const LIBBLURAY = 'org/videolan/Libbluray';
/** _bdj_init's disc ID when AACS gives none. */
const NO_DISC_ID = '00000000000000000000000000000000';
const DISC_ROOT = '/disc/';
const PERSISTENT_ROOT = '/persistent/';
const BUDA_ROOT = '/buda/';
const STOP_TIMEOUT_MS = 5000;

/** _create_jvm's -D options for a Java 8 JVM. */
const JVM_PROPERTIES: ReadonlyMap<string, string> = new Map([
  ['awt.toolkit', 'java.awt.BDToolkit'],
  ['java.awt.graphicsenv', 'java.awt.BDGraphicsEnvironment'],
  ['java.awt.headless', 'false'],
  ['javax.accessibility.assistive_technologies', ' '],
]);

const ERROR_CODES: readonly (readonly [string, BdjErrorCode])[] = [
  ['java/lang/NoClassDefFoundError', 'class-not-found'],
  ['java/lang/ClassNotFoundException', 'class-not-found'],
  ['java/lang/UnsatisfiedLinkError', 'unsatisfied-link'],
  ['java/lang/ClassFormatError', 'verify'],
  ['java/lang/VerifyError', 'verify'],
];

export class BdjRuntime {
  readonly host: BdjHost;
  readonly jvm: Jvm;
  private booted = false;
  private booting: Promise<void> | null = null;
  private until: ((e: TraceEntry) => boolean) | null = null;
  private matched = false;
  /** Aborts the drive in progress (run, or stop's). */
  private driving: AbortController | null = null;
  private active: Promise<unknown> | null = null;

  constructor(private readonly deps: BdjRuntimeDeps) {
    const inner = deps.host(
      (title) => this.playBdj(title),
      (e) => this.onTrace(e),
    );
    this.host = inner;
    const lib = deps.classLibrary;
    this.jvm = new Jvm({
      bootJars: [lib.libbluray, lib.libblurayAwt, lib.rt],
      nowMs: deps.nowMs,
      setTimer: deps.setTimer,
      stdout: (s) => this.output(s),
      stderr: (s) => this.output(s),
      vfs: new Vfs({ disc: deps.disc, discPaths: deps.disc.paths(), jdkLib: ZipArchive.open(lib.rt), nowMs: deps.nowMs }),
      systemProperties: JVM_PROPERTIES,
    });
    registerLibblurayNatives(this.jvm.natives, this.logging(inner));
  }

  /** Runtime.halt's status, once Java has halted the JVM; nothing runs after that. */
  get exitStatus(): number | null {
    return this.jvm.exitStatus;
  }

  /** bdj_open without JVM discovery: JDK startup, then _bdj_init (Libbluray.init). */
  boot(): Promise<void> {
    return (this.booting ??= this.open());
  }

  private async open(): Promise<void> {
    try {
      await this.jvm.boot();
    } catch (e) {
      throw this.bootError(e);
    }
    const heap = this.jvm.heap;
    await this.call('init', '(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V', [
      1n,
      heap.newString(NO_DISC_ID),
      heap.newString(DISC_ROOT),
      heap.newString(PERSISTENT_ROOT),
      heap.newString(BUDA_ROOT),
    ]);
    this.booted = true;
  }

  /** _start_bdj */
  start(title: number): void {
    this.processEvent(BdjEvent.START, title);
  }

  /** The host's title start, after its native has returned: _play_bdj logs a title it cannot start. */
  private playBdj(title: number): void {
    try {
      this.start(title);
    } catch (e) {
      this.deps.log(`Can't play BD-J title ${title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** bdj_process_event: Libbluray.processEvent on a fresh Java thread, which the next run() executes. */
  processEvent(ev: number, param: number): void {
    this.checkRunning();
    this.logEvent(ev, param);
    this.spawn('processEvent', '(II)Z', [ev | 0, param | 0]);
  }

  private logEvent(ev: number, param: number): void {
    if (ev > BDJ_EVENT_LAST) this.deps.log(`bdj_process_event(${ev},${param}): unknown event`);
    else if (ev !== BdjEvent.PTS) this.deps.log(`bdj_process_event(${EVENT_NAMES[ev]},${param})`);
  }

  /**
   * Runs the Java threads until none can make progress, `until` matches a trace entry, `signal` aborts or every
   * live thread deadlocks. Waits for sleeping threads on the injected clock. Rejects with BdjError('internal') when
   * the interpreter or the host fails, after which the runtime is stopped.
   */
  run(opts: { readonly signal?: AbortSignal; readonly until?: (e: TraceEntry) => boolean } = {}): Promise<RunOutcome> {
    return this.exclusive(async () => {
      this.until = opts.until ?? null;
      this.matched = false;
      try {
        return await this.drive(opts.signal, null);
      } finally {
        this.until = null;
      }
    });
  }

  /** _stop_bdj, then bdj_close (Libbluray.shutdown); threads still running after `timeoutMs` are halted. */
  async stop(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
    this.driving?.abort();
    await this.exclusive(async () => {
      if (!this.booted || this.jvm.threads.isHalted) return;
      const expired = new AbortController();
      const cancel = this.deps.setTimer(timeoutMs, () => expired.abort());
      try {
        this.logEvent(BdjEvent.STOP, 0);
        await this.drive(expired.signal, this.spawn('processEvent', '(II)Z', [BdjEvent.STOP, 0]));
        if (!expired.signal.aborted) await this.drive(expired.signal, this.spawn('shutdown', '()V', []));
      } finally {
        cancel();
        this.jvm.threads.halt();
      }
    });
  }

  private onTrace(e: TraceEntry): void {
    if (!this.until || this.matched || !this.until(e)) return;
    this.matched = true;
    this.jvm.threads.preempt();
    this.driving?.abort();
  }

  private output(s: string): void {
    for (const line of s.split('\n')) if (line !== '') this.deps.log(line);
  }

  /** The host the natives see: its log also reaches the runtime's log, as bdpriv_debug prints Logger.logN lines. */
  private logging(inner: BdjHost): BdjHost {
    const log = (file: string | null, line: number, msg: string, error: boolean): void => {
      inner.log(file, line, msg, error);
      this.deps.log(`${file ?? 'JVM'}:${line}: ${msg}`);
    };
    return new Proxy(inner, {
      get: (target, key) => {
        if (key === 'log') return log;
        const v: unknown = Reflect.get(target, key);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  private checkRunning(): void {
    if (this.jvm.exitStatus !== null) throw new BdjError('internal', `the JVM has halted with status ${this.jvm.exitStatus}`);
    if (this.jvm.threads.isHalted) throw new BdjError('internal', 'the BD-J runtime has stopped');
    if (!this.booted) throw new BdjError('internal', 'the BD-J runtime has not booted');
  }

  /** A static Libbluray method on a new Java thread, attached as the main thread as a JNI caller's would be. */
  private spawn(name: string, desc: string, args: readonly JValue[]): JThread {
    const m = this.method(name, desc);
    const t = this.jvm.threads.spawn(this.jvm.mainThread, m, args);
    if (this.jvm.mainThread) this.jvm.mainThread.nativeData = t;
    return t;
  }

  private method(name: string, desc: string): JMethod {
    const cls = this.jvm.loader.loadBoot(LIBBLURAY);
    if (!cls) throw new BdjError('class-not-found', `${LIBBLURAY} is missing from the boot class path (needed by bdj_open)`);
    const m = cls.methods.get(name + desc);
    if (!m?.isStatic) throw new BdjError('class-not-found', `${externalName(LIBBLURAY)}.${name}${desc} is missing`);
    return m;
  }

  /** _bdj_init's CallStaticVoidMethod: runs until its thread ends; an uncaught exception fails the boot. */
  private async call(name: string, desc: string, args: readonly JValue[]): Promise<void> {
    const t = this.withJava(() => this.spawn(name, desc, args));
    await this.drive(undefined, t);
    if (this.jvm.exitStatus !== null) throw new BdjError('internal', `the JVM halted with status ${this.jvm.exitStatus} during ${name}`);
    if (t.uncaught) throw this.javaError(t.uncaught, `Failed to initialize BD-J (uncaught exception): `);
    if (t.state !== 'terminated') throw new BdjError('internal', `${externalName(LIBBLURAY)}.${name} did not finish`);
  }

  /** Converts a Java exception thrown while setting up a call (class loading, initialisation) to a BdjError. */
  private withJava<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw this.bootError(e);
    }
  }

  private bootError(e: unknown): BdjError {
    if (e instanceof BdjError) return e;
    if (e instanceof JavaThrowable) return this.javaError(e.obj, '');
    const message = e instanceof Error ? e.message : String(e);
    for (const [cls, code] of ERROR_CODES) if (message.startsWith(externalName(cls))) return new BdjError(code, message);
    return new BdjError('internal', message);
  }

  private javaError(exc: JObject, prefix: string): BdjError {
    let code: BdjErrorCode = 'internal';
    for (const [name, c] of ERROR_CODES) {
      const cls = this.jvm.loader.loadBoot(name);
      if (cls && exc.cls.isSubclassOf(cls)) {
        code = c;
        break;
      }
    }
    const stack = this.exceptionStack(exc);
    const where = stack[0] ? ` (in ${stack[0]})` : '';
    return new BdjError(code, `${prefix}${this.jvm.describe(exc)}${where}`, stack);
  }

  private exceptionStack(exc: JObject): string[] {
    const trace = exc.nativeData as StackTrace | null | undefined;
    if (!trace?.methods) return [];
    return trace.methods.map((m, i) => frameText(m, trace.pcs[i]!));
  }

  /** One drive at a time: run() and stop() take turns on the scheduler. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active) await this.active.catch(() => undefined);
    const p = fn();
    this.active = p;
    try {
      return await p;
    } finally {
      if (this.active === p) this.active = null;
    }
  }

  /**
   * Runs the scheduler until `target` ends (or, without one, `until` matches), an abort, a deadlock or true
   * idleness: Scheduler.run returns 'idle' while threads sleep, so this waits for the next timer and goes on
   * (rulings R19/R20).
   */
  private async drive(signal: AbortSignal | undefined, target: JThread | null): Promise<RunOutcome> {
    const threads = this.jvm.threads;
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) ac.abort();
    const done = (): boolean => (target ? target.state === 'terminated' : this.matched);
    if (target) target.onTerminate = onAbort;
    this.driving = ac;
    try {
      for (;;) {
        let outcome: Awaited<ReturnType<typeof threads.run>>;
        try {
          outcome = await threads.run(ac.signal);
        } catch (e) {
          throw this.internal(e);
        }
        if (done()) return 'until';
        if (threads.isHalted) return 'idle';
        if (outcome === 'aborted') return 'aborted';
        if (outcome === 'deadlock') return 'deadlock';
        if (!threads.timersPending) return 'idle';
        await new Promise<void>((resolve) => {
          const stopWaiting = (): void => resolve();
          ac.signal.addEventListener('abort', stopWaiting, { once: true });
          void threads.nextTimer().then(() => {
            ac.signal.removeEventListener('abort', stopWaiting);
            resolve();
          });
        });
      }
    } finally {
      if (this.driving === ac) this.driving = null;
      if (target) target.onTerminate = null;
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** An interpreter or host failure: the runtime stops, and the error carries the Java stack of the thread at fault. */
  private internal(e: unknown): BdjError {
    const t = this.jvm.threads.faulted;
    const stack = t ? [...t.frames].reverse().map((f) => frameText(f.method, f.pc)) : [];
    this.jvm.threads.halt();
    if (e instanceof BdjError) return e;
    const message = e instanceof Error ? e.message : String(e);
    return new BdjError('internal', stack[0] ? `${message} (in ${stack[0]})` : message, stack);
  }
}

/** A frame as StackTraceElement.toString prints it. */
function frameText(m: JMethod, pc: number): string {
  const line = lineNumber(m, pc);
  const file = m.cls.file?.sourceFile;
  const where = m.isNative ? 'Native Method' : file ? (line >= 0 ? `${file}:${line}` : file) : 'Unknown Source';
  return `${externalName(m.cls.name)}.${m.name}(${where})`;
}
