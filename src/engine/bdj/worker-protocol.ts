/*
 * Original code for bluray-web: the messages between the engine worker and the BD-J worker.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { DiscFiles, DiscSourceRef, HttpDiscRef } from '../disc/http-source';
import type { ScreenRect } from './background';
import type { BdjErrorCode } from './errors';
import type { Coalesce } from './input';
import type { ClassLibrarySource } from './runtime';

/** A call argument or reply value; a Java long crosses as a decimal string. */
export type BdjWireValue = number | string | boolean | null;

export type ToBdj =
  | {
      readonly type: 'boot';
      readonly registers: SharedArrayBuffer;
      readonly status: SharedArrayBuffer;
      /** The graphics plane (graphics-plane.ts) Java's updateGraphicN draws into. */
      readonly plane: SharedArrayBuffer;
      /** The picked files; empty when the disc is served over HTTP (`discHttp`): Blobs of remote files cannot cross. */
      readonly discFiles: readonly (readonly [string, Blob])[];
      /** A disc served over HTTP: the BD-J worker opens its own HttpSource. */
      readonly discHttp?: HttpDiscRef;
      readonly discId: string | null;
      readonly classLibrary: ClassLibrarySource;
    }
  | { readonly type: 'start'; readonly title: number }
  /** `coalesce`: a key repeat or pointer move, which may merge with the one before it in a full queue (input.ts). */
  | { readonly type: 'event'; readonly ev: number; readonly param: number; readonly coalesce?: Coalesce }
  | { readonly type: 'reply'; readonly id: number; readonly value: number | string };

export type FromBdj =
  | { readonly type: 'booted'; readonly bootMs: number }
  | { readonly type: 'call'; readonly id: number; readonly name: BdjCallName; readonly args: readonly BdjWireValue[] }
  | { readonly type: 'log'; readonly line: string; readonly error: boolean }
  /** HStillImageBackgroundConfiguration.displayImage: the still's encoded bytes (null: none) and where it goes. */
  | { readonly type: 'background'; readonly image: Uint8Array | null; readonly rect: ScreenRect }
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

/** The boot message's disc fields for picked files or a served disc. */
export function bootDiscFields(disc: DiscFiles | DiscSourceRef): { readonly discFiles: DiscFiles; readonly discHttp?: HttpDiscRef } {
  if (!('kind' in disc)) return { discFiles: disc };
  return disc.kind === 'files' ? { discFiles: disc.entries } : { discFiles: [], discHttp: { baseUrl: disc.baseUrl, token: disc.token } };
}
