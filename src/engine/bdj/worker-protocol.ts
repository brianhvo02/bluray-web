/*
 * Original code for bluray-web: the messages between the engine worker and the BD-J worker.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { DiscSpec } from '../disc/disc-spec';
import type { BdjErrorCode } from './errors';
import type { ClassLibrarySource } from './runtime';

/** A call argument or reply value; a Java long crosses as a decimal string. */
export type BdjWireValue = number | string | boolean | null;

export type ToBdj =
  | {
      readonly type: 'boot';
      readonly registers: SharedArrayBuffer;
      readonly status: SharedArrayBuffer;
      readonly disc: DiscSpec;
      /** A NAS disc's read-ahead budget (the engine's memory profile). */
      readonly readAheadBytes: number;
      readonly discId: string | null;
      readonly classLibrary: ClassLibrarySource;
    }
  /** A fresh session token for a NAS disc; may arrive before the boot. */
  | { readonly type: 'remoteToken'; readonly token: string }
  | { readonly type: 'start'; readonly title: number }
  | { readonly type: 'event'; readonly ev: number; readonly param: number }
  | { readonly type: 'reply'; readonly id: number; readonly value: number | string };

export type FromBdj =
  | { readonly type: 'booted'; readonly bootMs: number }
  | { readonly type: 'call'; readonly id: number; readonly name: BdjCallName; readonly args: readonly BdjWireValue[] }
  | { readonly type: 'log'; readonly line: string; readonly error: boolean }
  | { readonly type: 'failed'; readonly code: BdjFailureCode; readonly message: string }
  /** The NAS answered 401: the engine asks the controller for a fresh token and sends it as remoteToken. */
  | { readonly type: 'remoteTokenNeeded' };

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
