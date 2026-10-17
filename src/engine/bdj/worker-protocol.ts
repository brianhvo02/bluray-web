/*
 * Original code for bluray-web: the messages between the engine worker and the BD-J worker.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { BdjErrorCode } from './errors';
import type { ClassLibrarySource } from './runtime';

/** A call argument or reply value; a Java long crosses as a decimal string. */
export type BdjWireValue = number | string | boolean | null;

export type ToBdj =
  | {
      readonly type: 'boot';
      readonly registers: SharedArrayBuffer;
      readonly status: SharedArrayBuffer;
      readonly discFiles: readonly (readonly [string, Blob])[];
      readonly discId: string | null;
      readonly classLibrary: ClassLibrarySource;
      readonly playerSettings?: unknown;
    }
  | { readonly type: 'start'; readonly title: number }
  | { readonly type: 'event'; readonly ev: number; readonly param: number }
  | { readonly type: 'reply'; readonly id: number; readonly value: number | string }
  | { readonly type: 'stop' };

export type FromBdj =
  | { readonly type: 'booted'; readonly bootMs: number }
  | { readonly type: 'call'; readonly id: number; readonly name: BdjCallName; readonly args: readonly BdjWireValue[] }
  | { readonly type: 'log'; readonly line: string; readonly error: boolean }
  | { readonly type: 'failed'; readonly code: BdjFailureCode; readonly message: string };

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
