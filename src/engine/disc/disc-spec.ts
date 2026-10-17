/*
 * Original code for bluray-web: what a disc is opened from, as it crosses between workers.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { FileSource } from './file-source';
import { HttpTransport } from './http-transport';
import type { DiscManifest } from './nas-api';
import { normalizeDiscPaths } from './paths';
import { RemoteSource } from './remote-source';

/** Picked files (paths as the picker reports them), or a disc on the NAS. Structured-cloneable. */
export type DiscSpec =
  | { readonly kind: 'files'; readonly entries: ReadonlyArray<readonly [string, Blob]> }
  | RemoteDiscSpec;

export interface RemoteDiscSpec {
  readonly kind: 'remote';
  /** The disc's API base, ending with '/': `https://…/bluray/api/discs/<id>/`. */
  readonly base: string;
  readonly token: string;
  readonly manifest: DiscManifest;
}

export interface ByteSourceDeps {
  readonly fetch: typeof fetch;
  readonly readAheadBytes: number;
  /** Size of one range request; REMOTE_CHUNK_BYTES by default. */
  readonly chunkBytes?: number;
  onWaiting(waiting: boolean): void;
  /** A fresh session token after a 401; without it a 401 means unpaired. */
  refreshToken?(): Promise<string>;
}

export const REMOTE_CHUNK_BYTES = 2 * 1024 * 1024;
export const REMOTE_IN_FLIGHT = 4;

/** The disc's bytes: picked files from disk, or the NAS by HTTP range reads. */
export function createByteSource(spec: DiscSpec, deps: ByteSourceDeps): FileSource | RemoteSource {
  if (spec.kind === 'files') return new FileSource(normalizeDiscPaths(spec.entries));
  const transport = new HttpTransport(spec.base, spec.token, {
    fetch: deps.fetch,
    ...(deps.refreshToken ? { refreshToken: () => deps.refreshToken!() } : {}),
  });
  return new RemoteSource(spec.manifest, transport, {
    readAheadBytes: deps.readAheadBytes,
    chunkBytes: deps.chunkBytes ?? REMOTE_CHUNK_BYTES,
    inFlight: REMOTE_IN_FLIGHT,
    onWaiting: (waiting) => deps.onWaiting(waiting),
  });
}
