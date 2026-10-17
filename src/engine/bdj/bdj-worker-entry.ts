/*
 * Original code for bluray-web: the BD-J worker's entry point. Like the engine worker's entry, which loads the class
 * library's jars, it brings in the class library's own intrinsics (src/bdj-classlib/intrinsics, GPLv2 with the
 * Classpath Exception); the rest of src/engine does not import from the class library. It also gives the worker
 * FreeType (src/wasm/freetype/freetype.wasm) and the fallback font (src/engine/ass/default-font.ttf), each fetched the
 * first time BD-J text needs it.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import freetypeWasmUrl from '../../wasm/freetype/freetype.wasm?url';
import defaultFontUrl from '../ass/default-font.ttf?url';
import { registerClassLibraryIntrinsics } from '../../bdj-classlib/intrinsics/index';
import { runBdjWorker, type BdjPort } from './bdj-worker';
import { loadFreeType, type FreeType } from './fonts/freetype';

/** As the engine worker's asset fetches (the audio wasm, the default font, the class library jars). */
const ASSET_FETCH_TIMEOUT_MS = 20_000;

let freeType: Promise<FreeType> | null = null;
let defaultFont: Promise<Uint8Array> | null = null;

const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

runBdjWorker(globalThis as unknown as BdjPort, {
  extraIntrinsics: registerClassLibraryIntrinsics,
  loadFreeType: () =>
    (freeType ??= loadFreeType(fetch(freetypeWasmUrl, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) })).catch((e: unknown) => {
      freeType = null; // the natives try again with the next font
      throw e;
    })),
  loadDefaultFont: () =>
    (defaultFont ??= fetchBytes(defaultFontUrl).catch((e: unknown) => {
      defaultFont = null;
      throw e;
    })),
});
