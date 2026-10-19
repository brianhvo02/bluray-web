/*
 * Original code for bluray-web: the messages between the engine worker and the BD-J worker.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { discTransfer, type DiscSpec } from '../disc/disc-spec';
import type { ScreenRect } from './background';
import type { BdjErrorCode } from './errors';
import type { Coalesce } from './input';
import type { BdjMemoryBudgets, ClassLibrarySource } from './runtime';
import type { JvmMemoryStats } from './jvm/jvm';

/** A call argument or reply value; a Java long crosses as a decimal string. */
export type BdjWireValue = number | string | boolean | null;

export type ToBdj =
  | {
      readonly type: 'boot';
      readonly registers: SharedArrayBuffer;
      readonly status: SharedArrayBuffer;
      /** The graphics plane (graphics-plane.ts) Java's updateGraphicN draws into. */
      readonly plane: SharedArrayBuffer;
      /** Picked files, or a disc on the NAS (or the dev disc server), which the BD-J worker reads with its own RemoteSource. */
      readonly disc: DiscSpec;
      /** The BD-J worker's read-ahead budget for a NAS disc (the memory profile's bdjRemoteReadAheadBytes). */
      readonly readAheadBytes: number;
      readonly discId: string | null;
      readonly classLibrary: ClassLibrarySource;
      /** The memory profile's budgets (none: no limits). */
      readonly memory?: BdjMemoryBudgets;
      /** Report the memory stats (a `memory` message) at once and every this many ms (telemetry runs only). */
      readonly memoryStatsMs?: number;
    }
  /** A fresh session token for a NAS disc; may arrive before the boot. */
  | { readonly type: 'remoteToken'; readonly token: string }
  | { readonly type: 'start'; readonly title: number }
  /** `coalesce`: a key repeat or pointer move, which may merge with the one before it in a full queue (input.ts). */
  | { readonly type: 'event'; readonly ev: number; readonly param: number; readonly coalesce?: Coalesce }
  | { readonly type: 'reply'; readonly id: number; readonly value: number | string }
  /** Log a thread dump (diagnostics), then answer `dumped`. */
  | { readonly type: 'dump'; readonly reason: string };

export type FromBdj =
  | { readonly type: 'booted'; readonly bootMs: number }
  | { readonly type: 'call'; readonly id: number; readonly name: BdjCallName; readonly args: readonly BdjWireValue[] }
  | { readonly type: 'log'; readonly line: string; readonly error: boolean }
  /** HStillImageBackgroundConfiguration.displayImage: the still's encoded bytes (null: none) and where it goes. */
  | { readonly type: 'background'; readonly image: Uint8Array | null; readonly rect: ScreenRect }
  | { readonly type: 'failed'; readonly code: BdjFailureCode; readonly message: string }
  | { readonly type: 'memory'; readonly jvm: JvmMemoryStats; readonly freeType: { readonly wasmBytes: number; readonly faces: number } | null }
  /** The NAS answered 401: the engine asks the controller for a fresh token and sends it as remoteToken. */
  | { readonly type: 'remoteTokenNeeded' }
  /** The thread dump asked for has been logged. */
  | { readonly type: 'dumped' };

export type BdjFailureCode = BdjErrorCode | 'halted' | 'timeout';

/** The natives the engine answers; getPlaylistInfoN is answered in the BD-J worker from its own disc model. */
export type BdjCallName =
  | 'selectTitle'
  | 'selectPlaylist'
  | 'seek'
  | 'selectAngle'
  | 'selectRate'
  | 'writeReg'
  | 'soundEffect'
  | 'setVirtualPackage'
  | 'setUOMask'
  | 'setKeyInterest';

/** What posting `m` must transfer: a boot message's fetch port (the WebRTC route), else nothing. */
export function bootTransfer(m: ToBdj): Transferable[] {
  return m.type === 'boot' ? discTransfer(m.disc) : [];
}
