/*
 * Original code for bluray-web: java.net natives of the BD-J virtual machine. There is no network in this milestone:
 * the only host name is localhost, lookups fail and connections throw ConnectException.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { NativeResult } from '../interpreter';
import type { JValue } from '../values';
import type { NativeContext, NativeTable } from './index';
import { jsStr, none } from './util';

const disabled = (ctx: NativeContext): NativeResult => ctx.jvm.throwNew('java/net/ConnectException', 'network disabled');
const unknownHost = (ctx: NativeContext, _self: JValue, host: JValue): NativeResult =>
  ctx.jvm.throwNew('java/net/UnknownHostException', typeof host === 'object' && host !== null && host.cls.name === 'java/lang/String' ? `${jsStr(ctx.jvm, host)}: network disabled` : 'network disabled');

export function registerNetNatives(natives: NativeTable): void {
  const impl = (cls: string): Record<string, (ctx: NativeContext, ...args: JValue[]) => NativeResult> => ({
    [`java/net/${cls}.getLocalHostName()Ljava/lang/String;`]: (ctx) => ctx.jvm.heap.newString('localhost'),
    [`java/net/${cls}.lookupAllHostAddr(Ljava/lang/String;)[Ljava/net/InetAddress;`]: unknownHost,
    [`java/net/${cls}.getHostByAddr([B)Ljava/lang/String;`]: unknownHost,
  });
  natives.register({
    'java/net/InetAddress.init()V': none,
    'java/net/Inet4Address.init()V': none,
    'java/net/Inet6Address.init()V': none,
    // rt-bdj.jar carries Inet6AddressImpl only, which InetAddressImplFactory picks when IPv6 is supported.
    'java/net/InetAddressImplFactory.isIPv6Supported()Z': () => 1,
    ...impl('Inet6AddressImpl'),
    ...impl('Inet4AddressImpl'),
    'java/net/Inet6AddressImpl.isReachable0([BII[BII)Z': () => 0,
    'java/net/Inet4AddressImpl.isReachable0([BI[BI)Z': () => 0,
    'java/net/PlainSocketImpl.initProto()V': none,
    'java/net/PlainSocketImpl.socketConnect(Ljava/net/InetAddress;II)V': disabled,
    // a socket can be made, configured and closed; it never connects, so it is never read or written
    'java/net/PlainSocketImpl.socketCreate(Z)V': none,
    'java/net/PlainSocketImpl.socketSetOption0(IZLjava/lang/Object;)V': none,
    'java/net/PlainSocketImpl.socketClose0(Z)V': none,
    'java/net/SocketInputStream.init()V': none,
    'java/net/SocketOutputStream.init()V': none,
    'java/net/SocketInputStream.socketRead0(Ljava/io/FileDescriptor;[BIII)I': (ctx) => ctx.jvm.throwNew('java/net/SocketException', 'Socket is not connected'),
    'java/net/SocketOutputStream.socketWrite0(Ljava/io/FileDescriptor;[BII)V': (ctx) => ctx.jvm.throwNew('java/net/SocketException', 'Socket is not connected'),
    'java/net/PlainDatagramSocketImpl.init()V': none,
    'java/net/PlainDatagramSocketImpl.connect0(Ljava/net/InetAddress;I)V': disabled,
  });
}
