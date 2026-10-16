/*
 * Original code for bluray-web: the BD-J virtual machine, which runs Java 8 class files on green threads in one JS
 * thread.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ZipArchive } from './zip';
import { Heap } from './heap';
import { ClassPath, Loader, externalName } from './loader';
import type { JClass, JMethod } from './loader';
import { ThrowResult } from './interpreter';
import { JThread, Scheduler } from './threads';
import { NativeTable, registerBootstrapNatives } from './natives/index';
import { JavaThrowable } from './values';
import type { JObject, JValue } from './values';

export interface JvmOptions {
  readonly bootJars: readonly Uint8Array[];
  readonly nowMs: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
}

/** A Throwable's stack, innermost first, kept in its nativeData. */
export interface StackTrace {
  readonly methods: readonly JMethod[];
  readonly pcs: readonly number[];
}

/** HotSpot's MaxJavaStackTraceDepth. */
const MAX_TRACE_DEPTH = 1024;
const TIME_SLICE = 10_000;

export class Jvm {
  readonly heap: Heap;
  readonly loader: Loader;
  readonly threads: Scheduler;
  readonly natives: NativeTable;
  /** The thread the interpreter is running, if any. */
  currentThread: JThread | null = null;

  constructor(readonly opts: JvmOptions) {
    this.heap = new Heap(this);
    this.loader = new Loader(this, new ClassPath(opts.bootJars.map((b) => ZipArchive.open(b))));
    this.natives = new NativeTable();
    registerBootstrapNatives(this.natives);
    this.threads = new Scheduler(this, { slice: TIME_SLICE, nowMs: opts.nowMs, setTimer: opts.setTimer });
  }

  /** Runs a static method on a new Java thread to completion; rejects with the uncaught exception's toString(). */
  async callStatic(cls: string, name: string, desc: string, args: readonly JValue[] = []): Promise<JValue | undefined> {
    let t: JThread;
    try {
      const c = this.loader.loadBoot(cls);
      if (!c) throw new Error(`java.lang.NoClassDefFoundError: ${cls}`);
      const m = c.methods.get(name + desc);
      if (!m?.isStatic) throw new Error(`java.lang.NoSuchMethodError: ${externalName(cls)}.${name}${desc}`);
      t = this.threads.spawn(null, m, args);
    } catch (e) {
      if (e instanceof JavaThrowable) throw new Error(this.describe(e.obj));
      throw e;
    }
    const outcome = await this.threads.run();
    if (t.uncaught) throw new Error(this.describe(t.uncaught));
    if (t.state !== 'terminated') throw new Error(`${externalName(cls)}.${name} did not finish (${outcome})`);
    return t.result;
  }

  /** JDK startup: System.initializeSystemClass and the main thread group. */
  boot(): Promise<void> {
    return Promise.reject(new Error('Jvm.boot is not implemented yet'));
  }

  /** Allocates a Throwable without running Java constructors, as HotSpot's own exceptions are. */
  throwNew(cls: string, message?: string): ThrowResult {
    const c = this.loader.loadBoot(cls);
    if (!c) throw new Error(`${cls} is not on the boot class path`);
    const e = this.heap.newObject(c);
    if (message !== undefined) this.setField(e, 'detailMessage', 'Ljava/lang/String;', this.heap.newString(message));
    this.setField(e, 'cause', 'Ljava/lang/Throwable;', e);
    const throwable = this.loader.loadBoot('java/lang/Throwable')!;
    if (throwable.state === 'initialized') {
      const sentinel = throwable.findField('SUPPRESSED_SENTINEL', 'Ljava/util/List;');
      if (sentinel) this.setField(e, 'suppressedExceptions', 'Ljava/util/List;', throwable.staticValues[sentinel.slot]!);
    }
    this.fillInStackTrace(e, this.currentThread);
    return new ThrowResult(e);
  }

  /**
   * Records the thread's frames in the Throwable, leaving out fillInStackTrace and the Throwable's own constructors
   * as HotSpot does; `backtrace` becomes non-null so getOurStackTrace builds the elements.
   */
  fillInStackTrace(e: JObject, t: JThread | null): void {
    const methods: JMethod[] = [];
    const pcs: number[] = [];
    const frames = t?.frames ?? [];
    let i = frames.length - 1;
    while (i >= 0 && frames[i]!.method.name.startsWith('fillInStackTrace')) i--;
    while (i >= 0 && frames[i]!.method.name === '<init>' && e.cls.isSubclassOf(frames[i]!.method.cls)) i--;
    for (; i >= 0 && methods.length < MAX_TRACE_DEPTH; i--) {
      methods.push(frames[i]!.method);
      pcs.push(frames[i]!.pc);
    }
    const trace: StackTrace = { methods, pcs };
    e.nativeData = trace;
    this.setField(e, 'backtrace', 'Ljava/lang/Object;', e);
  }

  /** The java.lang.Class instance for a class. */
  mirror(cls: JClass): JObject {
    if (!cls.mirror) {
      const classClass = this.loader.loadBoot('java/lang/Class');
      if (!classClass) throw new Error('java/lang/Class is not on the boot class path');
      const m = this.heap.newObject(classClass);
      m.nativeData = cls;
      const loaderField = classClass.findField('classLoader', 'Ljava/lang/ClassLoader;');
      if (loaderField) m.fields[loaderField.slot] = cls.loader;
      cls.mirror = m;
    }
    return cls.mirror;
  }

  getField(o: JObject, name: string, desc: string): JValue {
    const f = o.cls.findField(name, desc);
    if (!f || f.isStatic) throw new Error(`${o.cls.name} has no field ${name} ${desc}`);
    return o.fields[f.slot]!;
  }

  setField(o: JObject, name: string, desc: string, value: JValue): void {
    const f = o.cls.findField(name, desc);
    if (!f || f.isStatic) throw new Error(`${o.cls.name} has no field ${name} ${desc}`);
    o.fields[f.slot] = value;
  }

  /** Throwable.toString(), computed natively: the class name, then ': ' and the detail message if there is one. */
  describe(e: JObject): string {
    const message = this.heap.jsString(this.getField(e, 'detailMessage', 'Ljava/lang/String;') as JObject | null);
    return message === null ? externalName(e.cls.name) : `${externalName(e.cls.name)}: ${message}`;
  }
}
