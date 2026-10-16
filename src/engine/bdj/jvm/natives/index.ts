/*
 * Original code for bluray-web: the native-method table of the BD-J virtual machine.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JValue, JObject } from '../values';
import type { JMethod } from '../loader';
import type { JThread } from '../threads';
import type { Jvm } from '../jvm';
import type { NativeResult } from '../interpreter';

export interface NativeContext {
  readonly jvm: Jvm;
  readonly thread: JThread;
  readonly method: JMethod;
}

/** Receives the receiver (instance methods) and then one value per parameter; a long is one bigint. */
export type NativeFn = (ctx: NativeContext, ...args: JValue[]) => NativeResult;

export class NativeTable {
  private readonly fns = new Map<string, NativeFn>();

  /** Keys are 'java/lang/Object.hashCode()I'. */
  register(entries: Readonly<Record<string, NativeFn>>): void {
    for (const [key, fn] of Object.entries(entries)) this.fns.set(key, fn);
  }

  get(key: string): NativeFn | undefined {
    return this.fns.get(key);
  }

  get keys(): readonly string[] {
    return [...this.fns.keys()];
  }
}

const none = (): undefined => undefined;

/** The natives that code running before the JDK boots reaches. */
export function registerBootstrapNatives(table: NativeTable): void {
  table.register({
    'java/lang/Object.registerNatives()V': none,
    'java/lang/Object.hashCode()I': (ctx, self) => ctx.jvm.heap.identityHash(self as JObject),
    'java/lang/Object.getClass()Ljava/lang/Class;': (ctx, self) => ctx.jvm.mirror((self as JObject).cls),
    'java/lang/System.registerNatives()V': none,
    'java/lang/Class.registerNatives()V': none,
    'java/lang/Class.desiredAssertionStatus0(Ljava/lang/Class;)Z': () => 0,
    'java/lang/Throwable.fillInStackTrace(I)Ljava/lang/Throwable;': (ctx, self) => {
      ctx.jvm.fillInStackTrace(self as JObject, ctx.thread);
      return self;
    },
  });
}
