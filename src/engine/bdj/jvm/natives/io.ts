/*
 * Original code for bluray-web: java.io natives of the BD-J virtual machine over its Vfs. For now only what reading a
 * JDK data file needs (String.format reaches java.util.Currency, which reads /jdk/lib/currency.data, and
 * java.lang.invoke builds the system class loader, which canonicalises its class path): path canonicalisation, file
 * attributes, and FileInputStream's open0, readBytes and close0. File descriptors are integers kept in
 * FileDescriptor.fd, each standing for a VfsHandle.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { Suspend } from '../interpreter';
import type { Jvm } from '../jvm';
import type { VfsHandle } from '../vfs';
import type { JArray, JObject, JValue } from '../values';
import type { NativeContext, NativeTable } from './index';
import { jsStr } from './util';

const files = new WeakMap<Jvm, { handles: Map<number, VfsHandle>; next: number }>();

function table(jvm: Jvm): { handles: Map<number, VfsHandle>; next: number } {
  let t = files.get(jvm);
  if (!t) files.set(jvm, (t = { handles: new Map(), next: 3 }));
  return t;
}

/** The FileDescriptor of a FileInputStream. */
function fdOf(ctx: NativeContext, stream: JValue): JObject | null {
  return ctx.jvm.getField(stream as JObject, 'fd', 'Ljava/io/FileDescriptor;') as JObject | null;
}

function handleOf(ctx: NativeContext, stream: JValue): VfsHandle | null {
  const fd = fdOf(ctx, stream);
  if (fd === null) return null;
  return table(ctx.jvm).handles.get(ctx.jvm.getField(fd, 'fd', 'I') as number) ?? null;
}

function canonicalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '' && seg !== '.') out.push(seg);
  }
  return `/${out.join('/')}`;
}

export function registerIoNatives(natives: NativeTable): void {
  natives.register({
    'java/io/UnixFileSystem.canonicalize0(Ljava/lang/String;)Ljava/lang/String;': (ctx, _self, path) => {
      if (path === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      return ctx.jvm.heap.newString(canonicalize(jsStr(ctx.jvm, path)));
    },
    // BA_EXISTS with BA_REGULAR or BA_DIRECTORY.
    'java/io/UnixFileSystem.getBooleanAttributes0(Ljava/io/File;)I': (ctx, _self, f) => {
      if (f === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      const st = ctx.jvm.opts.vfs?.stat(jsStr(ctx.jvm, ctx.jvm.getField(f as JObject, 'path', 'Ljava/lang/String;'))) ?? null;
      return st === null ? 0 : st.kind === 'dir' ? 0x05 : 0x03;
    },
    'java/io/FileInputStream.open0(Ljava/lang/String;)V': (ctx, self, name) => {
      const jvm = ctx.jvm;
      if (name === null) return jvm.throwNew('java/lang/NullPointerException');
      const path = jsStr(jvm, name);
      const h = jvm.opts.vfs?.open(path, 'r') ?? null;
      if (!h) return jvm.throwNew('java/io/FileNotFoundException', `${path} (No such file or directory)`);
      const fd = fdOf(ctx, self);
      if (fd === null) return jvm.throwNew('java/lang/NullPointerException');
      const t = table(jvm);
      const n = t.next++;
      t.handles.set(n, h);
      jvm.setField(fd, 'fd', 'I', n);
      return undefined;
    },
    'java/io/FileInputStream.readBytes([BII)I': (ctx, self, b, off, len) => {
      const jvm = ctx.jvm;
      if (b === null) return jvm.throwNew('java/lang/NullPointerException');
      const data = (b as JArray).data as Int8Array;
      const o = off as number;
      const n = len as number;
      if (o < 0 || n < 0 || o + n > data.length) return jvm.throwNew('java/lang/IndexOutOfBoundsException');
      if (n === 0) return 0;
      const h = handleOf(ctx, self);
      if (!h) return jvm.throwNew('java/io/IOException', 'Stream Closed');
      const r = jvm.opts.vfs!.read(h, new Uint8Array(data.buffer, data.byteOffset, data.length), o, n);
      return typeof r === 'number' ? r : new Suspend(r);
    },
    'java/io/FileInputStream.close0()V': (ctx, self) => void close(ctx, self),
    // libbluray's FileInputStream declares close0 as returning int.
    'java/io/FileInputStream.close0()I': close,
  });
}

function close(ctx: NativeContext, self: JValue): number {
  const fd = fdOf(ctx, self);
  if (fd === null) return 0;
  const n = ctx.jvm.getField(fd, 'fd', 'I') as number;
  const t = table(ctx.jvm);
  const h = t.handles.get(n);
  if (h) {
    ctx.jvm.opts.vfs?.close(h);
    t.handles.delete(n);
  }
  ctx.jvm.setField(fd, 'fd', 'I', -1);
  return 0;
}
