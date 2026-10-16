/*
 * Original code for bluray-web: sun.misc natives of the BD-J virtual machine (VM, Signal, Version, Perf,
 * URLClassPath), and the few java.io natives the JDK boot itself needs: standard output and error, and the
 * initIDs of the stream, file-system and zip classes.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { Invoke } from '../interpreter';
import type { NativeResult } from '../interpreter';
import type { Jvm } from '../jvm';
import type { JThread } from '../threads';
import type { JArray, JObject, JValue } from '../values';
import type { NativeTable } from './index';
import { method, none } from './util';

const decoders = new WeakMap<Jvm, Map<number, TextDecoder>>();

/** Writes to fd 1 or 2 go to the host's stdout or stderr, decoded as UTF-8 across write boundaries. */
function writeStdio(jvm: Jvm, fdObj: JValue, bytes: Uint8Array): NativeResult {
  const fd = fdObj === null ? -1 : (jvm.getField(fdObj as JObject, 'fd', 'I') as number);
  if (fd !== 1 && fd !== 2) return jvm.throwNew('java/io/IOException', 'Bad file descriptor');
  let map = decoders.get(jvm);
  if (!map) decoders.set(jvm, (map = new Map()));
  let d = map.get(fd);
  if (!d) map.set(fd, (d = new TextDecoder('utf-8')));
  const s = d.decode(bytes, { stream: true });
  if (s !== '') (fd === 1 ? jvm.opts.stdout : jvm.opts.stderr)(s);
  return undefined;
}

function streamFd(jvm: Jvm, self: JValue): JValue {
  return jvm.getField(self as JObject, 'fd', 'Ljava/io/FileDescriptor;');
}

/** ByteBuffer.allocate(n), for sun.misc.Perf's counters. */
function allocateBuffer(jvm: Jvm, t: JThread, n: number, fill?: Int8Array): NativeResult {
  const bb = jvm.bootClass('java/nio/ByteBuffer');
  return jvm.withInit(t, bb, () =>
    new Invoke(method(bb, 'allocate(I)Ljava/nio/ByteBuffer;'), [n], (buf) => {
      if (fill) {
        const hb = jvm.getField(buf as JObject, 'hb', '[B') as JArray;
        (hb.data as Int8Array).set(fill.subarray(0, n));
      }
      return buf;
    }),
  );
}

export function registerMiscNatives(table: NativeTable): void {
  table.register({
    'sun/misc/VM.initialize()V': none,
    'sun/misc/VM.latestUserDefinedLoader0()Ljava/lang/ClassLoader;': (ctx) => {
      const frames = ctx.thread.frames;
      for (let i = frames.length - 1; i >= 0; i--) if (frames[i]!.method.cls.loader) return frames[i]!.method.cls.loader;
      return null;
    },
    'sun/misc/Signal.findSignal(Ljava/lang/String;)I': () => -1,
    'sun/misc/Signal.handle0(IJ)J': () => 0n,
    'sun/misc/Signal.raise0(I)V': none,
    'sun/misc/NativeSignalHandler.handle0(IJ)V': none,
    'sun/misc/Version.getJvmSpecialVersion()Ljava/lang/String;': (ctx) => ctx.jvm.heap.newString(''),
    'sun/misc/Version.getJdkSpecialVersion()Ljava/lang/String;': (ctx) => ctx.jvm.heap.newString(''),
    'sun/misc/Version.getJvmVersionInfo()Z': () => 0,
    'sun/misc/Version.getJdkVersionInfo()V': none,
    'sun/misc/Perf.registerNatives()V': none,
    'sun/misc/Perf.attach(Ljava/lang/String;II)Ljava/nio/ByteBuffer;': (ctx) =>
      ctx.jvm.throwNew('java/lang/IllegalArgumentException', 'no instrumentation buffer to attach to'),
    'sun/misc/Perf.detach(Ljava/nio/ByteBuffer;)V': none,
    'sun/misc/Perf.createLong(Ljava/lang/String;IIJ)Ljava/nio/ByteBuffer;': (ctx) => allocateBuffer(ctx.jvm, ctx.thread, 8),
    'sun/misc/Perf.createByteArray(Ljava/lang/String;II[BI)Ljava/nio/ByteBuffer;': (ctx, _self, _name, _v, _u, value, max) =>
      allocateBuffer(ctx.jvm, ctx.thread, max as number, (value as JArray).data as Int8Array),
    'sun/misc/Perf.highResCounter()J': (ctx) => BigInt(Math.round(ctx.jvm.opts.nowMs() * 1e6)),
    'sun/misc/Perf.highResFrequency()J': () => 1_000_000_000n,
    'sun/misc/URLClassPath.getLookupCacheURLs(Ljava/lang/ClassLoader;)[Ljava/net/URL;': () => null,
    'sun/misc/URLClassPath.getLookupCacheForClassLoader(Ljava/lang/ClassLoader;Ljava/lang/String;)[I': () => null,
    'sun/misc/URLClassPath.knownToNotExist0(Ljava/lang/ClassLoader;Ljava/lang/String;)Z': () => 0,

    'java/io/FileDescriptor.initIDs()V': none,
    'java/io/FileInputStream.initIDs()V': none,
    'java/io/FileOutputStream.initIDs()V': none,
    'java/io/UnixFileSystem.initIDs()V': none,
    'java/util/zip/ZipFile.initIDs()V': none,
    'java/io/FileOutputStream.writeBytes([BIIZ)V': (ctx, self, b, off, len) => {
      if (b === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      const data = (b as JArray).data as Int8Array;
      const o = off as number;
      const n = len as number;
      if (o < 0 || n < 0 || o + n > data.length) return ctx.jvm.throwNew('java/lang/IndexOutOfBoundsException');
      return writeStdio(ctx.jvm, streamFd(ctx.jvm, self), new Uint8Array(data.buffer, data.byteOffset + o, n));
    },
    'java/io/FileOutputStream.write(IZ)V': (ctx, self, b) => writeStdio(ctx.jvm, streamFd(ctx.jvm, self), new Uint8Array([(b as number) & 0xff])),
  });
}
