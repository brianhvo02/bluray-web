/*
 * Original code for bluray-web: intrinsics for the java.lang.String methods (and the UTF-8 decoder's ASCII case) that
 * the JDK's jar, manifest and class handling calls hundreds of thousands of times while a disc starts. Each is written
 * from the JVM semantics of the class library's bytecode; anything else (a supplementary code point, a non-ASCII byte,
 * an index the bytecode would throw on) declines to that bytecode.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JClass } from '../../loader';
import type { Jvm } from '../../jvm';
import type { JArray, JObject } from '../../values';
import { DECLINE, perClass, slotOf } from './common';
import type { IntrinsicFn } from './common';

const stringSlots = perClass((cls) => ({ value: slotOf(cls, 'value', '[C'), hash: slotOf(cls, 'hash', 'I') }));

const mathClasses = new WeakMap<Jvm, JClass>();

/** Whether java.lang.Math is initialised, so a call of Math.min that the bytecode makes has nothing else to do. */
function mathReady(jvm: Jvm): boolean {
  let math = mathClasses.get(jvm);
  if (!math) {
    const c = jvm.loader.loadBoot('java/lang/Math');
    if (!c) return false;
    mathClasses.set(jvm, (math = c));
  }
  return math.state === 'initialized';
}

/** The chars of a String (its value field), or null. */
const chars = (s: JObject, slot: number): Uint16Array | null => (s.fields[slot] as JArray | null)?.data as Uint16Array | null;

/** String.hashCode(): the cached hash, or 31-based over the chars, cached when computed. */
const hashCode: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const self = stack[base] as JObject;
  const s = stringSlots(m.cls);
  let h = self.fields[s.hash] as number;
  if (h !== 0) return h;
  const value = chars(self, s.value);
  if (value === null) return DECLINE;
  if (value.length === 0) return 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value[i]!) | 0;
  self.fields[s.hash] = h;
  return h;
};

/** String.charAt(int). */
const charAt: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const value = chars(stack[base] as JObject, stringSlots(m.cls).value);
  const i = stack[base + 1] as number;
  if (value === null || i < 0 || i >= value.length) return DECLINE;
  return value[i]!;
};

/** String.equals(Object): the same object, or a String with the same chars. */
const equals: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const self = stack[base] as JObject;
  const other = stack[base + 1] as JObject | null;
  if (self === other) return 1;
  if (other === null || other.cls !== m.cls) return 0; // String is final: instanceof String is this class
  const s = stringSlots(m.cls);
  const a = chars(self, s.value);
  const b = chars(other, s.value);
  if (a === null || b === null) return DECLINE;
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return 0;
  return 1;
};

/** String.indexOf(int ch, int fromIndex), for a ch below the supplementary range. */
const indexOf: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const value = chars(stack[base] as JObject, stringSlots(m.cls).value);
  const ch = stack[base + 1] as number;
  let from = stack[base + 2] as number;
  if (value === null) return DECLINE;
  if (from < 0) from = 0;
  else if (from >= value.length) return -1;
  if (ch >= 0x10000) return DECLINE;
  for (let i = from; i < value.length; i++) if (value[i] === ch) return i;
  return -1;
};

/** String.lastIndexOf(int ch, int fromIndex), for a ch below the supplementary range. */
const lastIndexOf: IntrinsicFn = (jvm, _t, m, stack, base) => {
  const value = chars(stack[base] as JObject, stringSlots(m.cls).value);
  const ch = stack[base + 1] as number;
  const from = stack[base + 2] as number;
  if (ch >= 0x10000) return DECLINE;
  if (value === null || !mathReady(jvm)) return DECLINE;
  for (let i = Math.min(from, value.length - 1); i >= 0; i--) if (value[i] === ch) return i;
  return -1;
};

/** String.startsWith(String prefix, int toffset). */
const startsWith: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const s = stringSlots(m.cls);
  const value = chars(stack[base] as JObject, s.value);
  const prefix = stack[base + 1] as JObject | null;
  const toffset = stack[base + 2] as number;
  if (value === null || prefix === null) return DECLINE;
  const pa = chars(prefix, s.value);
  if (pa === null) return DECLINE;
  if (toffset < 0 || toffset > value.length - pa.length) return 0;
  for (let i = 0; i < pa.length; i++) if (value[toffset + i] !== pa[i]) return 0;
  return 1;
};

/** UTF_8.Decoder.decode(byte[] sa, int sp, int len, char[] da) when every byte is ASCII and da has room: a copy. */
const utf8Decode: IntrinsicFn = (jvm, _t, _m, stack, base) => {
  const saArr = stack[base + 1] as JArray | null;
  const sp = stack[base + 2] as number;
  const len = stack[base + 3] as number;
  const daArr = stack[base + 4] as JArray | null;
  if (saArr === null || daArr === null || !mathReady(jvm)) return DECLINE;
  if (len <= 0) return 0;
  const sa = saArr.data as Int8Array;
  const da = daArr.data as Uint16Array;
  if (sp < 0 || sp + len > sa.length || len > da.length) return DECLINE;
  for (let i = 0; i < len; i++) if (sa[sp + i]! < 0) return DECLINE;
  for (let i = 0; i < len; i++) da[i] = sa[sp + i]!;
  return len;
};

export const stringIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'java/lang/String.hashCode()I': hashCode,
  'java/lang/String.charAt(I)C': charAt,
  'java/lang/String.equals(Ljava/lang/Object;)Z': equals,
  'java/lang/String.indexOf(II)I': indexOf,
  'java/lang/String.lastIndexOf(II)I': lastIndexOf,
  'java/lang/String.startsWith(Ljava/lang/String;I)Z': startsWith,
  'sun/nio/cs/UTF_8$Decoder.decode([BII[C)I': utf8Decode,
};
