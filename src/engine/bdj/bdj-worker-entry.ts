/*
 * Original code for bluray-web: the BD-J worker's entry point. Like the engine worker's entry, which loads the class
 * library's jars, it brings in the class library's own intrinsics (src/bdj-classlib/intrinsics, GPLv2 with the
 * Classpath Exception); the rest of src/engine does not import from the class library.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { registerClassLibraryIntrinsics } from '../../bdj-classlib/intrinsics/index';
import { runBdjWorker, type BdjPort } from './bdj-worker';

runBdjWorker(globalThis as unknown as BdjPort, { extraIntrinsics: registerClassLibraryIntrinsics });
