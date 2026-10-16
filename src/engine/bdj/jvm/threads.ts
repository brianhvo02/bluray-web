/*
 * Original code for bluray-web: Java threads of the BD-J virtual machine. This scheduler runs one thread at a time to
 * completion; the green-thread scheduler with monitors replaces it.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { JavaThrowable } from './values';
import type { JObject, JValue } from './values';
import type { JMethod } from './loader';
import type { Jvm } from './jvm';
import { Invoke, ThrowResult, andThen, complete, execute } from './interpreter';
import type { Frame } from './interpreter';

export type ThreadState =
  | 'runnable'
  | 'blocked-monitor'
  | 'waiting'
  | 'timed-waiting'
  | 'sleeping'
  | 'parked'
  | 'suspended-native'
  | 'terminated';

export class JThread {
  readonly frames: Frame[] = [];
  state: ThreadState = 'runnable';
  interrupted = false;
  uncaught: JObject | null = null;
  /** What the thread's first method returned. */
  result: JValue | undefined = undefined;
  constructor(
    readonly id: number,
    public javaThread: JObject | null,
  ) {}
}

export interface Monitor {
  owner: JThread | null;
  count: number;
  readonly entrySet: JThread[];
  readonly waitSet: JThread[];
}

export interface SchedulerOptions {
  readonly slice: number;
  readonly nowMs: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
}

export class Scheduler {
  private nextId = 1;
  private readonly threads: JThread[] = [];
  private readonly suspended = new Map<JThread, Promise<void>>();

  constructor(
    private readonly jvm: Jvm,
    private readonly opts: SchedulerOptions,
  ) {}

  get live(): readonly JThread[] {
    return this.threads.filter((t) => t.state !== 'terminated');
  }

  /** A static method's class is initialised first, as invokestatic would. */
  spawn(javaThread: JObject | null, method: JMethod, args: readonly JValue[]): JThread {
    const t = new JThread(this.nextId++, javaThread);
    this.threads.push(t);
    const call = (): Invoke =>
      new Invoke(method, args, (ret) => {
        t.result = ret;
        return undefined;
      });
    const init = method.isStatic ? this.jvm.loader.initialize(t, method.cls) : null;
    complete(this.jvm, t, init === null ? call() : andThen(init, call));
    return t;
  }

  monitorEnter(_t: JThread, _o: JObject): boolean {
    return true;
  }

  monitorExit(_t: JThread, _o: JObject): void {}

  suspendOn(t: JThread, p: Promise<JValue | undefined>): void {
    t.state = 'suspended-native';
    this.suspended.set(
      t,
      p.then(
        (v) => {
          this.suspended.delete(t);
          complete(this.jvm, t, v);
        },
        (e: unknown) => {
          this.suspended.delete(t);
          if (!(e instanceof JavaThrowable)) throw e;
          complete(this.jvm, t, new ThrowResult(e.obj));
        },
      ),
    );
  }

  async run(signal?: AbortSignal): Promise<'idle' | 'deadlock' | 'aborted'> {
    for (;;) {
      if (signal?.aborted) return 'aborted';
      const t = this.threads.find((x) => x.state === 'runnable');
      if (t) {
        execute(this.jvm, t, this.opts.slice);
        continue;
      }
      const waiting = this.suspended.values().next();
      if (waiting.done) return 'idle';
      await waiting.value;
    }
  }
}
