/*
 * Original code for bluray-web: the AWT natives of the BD-J virtual machine that are not libbluray's. They cache JNI
 * field IDs in the JDK, which this VM does not need, so they do nothing; libbluray's BDToolkit does the drawing.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { NativeFn, NativeTable } from './index';
import { none } from './util';

const INIT_IDS = [
  'java/awt/AWTEvent',
  'java/awt/Color',
  'java/awt/Component',
  'java/awt/Container',
  'java/awt/Cursor',
  'java/awt/Dialog',
  'java/awt/Dimension',
  'java/awt/Event',
  'java/awt/Font',
  'java/awt/FontMetrics',
  'java/awt/Frame',
  'java/awt/Insets',
  'java/awt/KeyboardFocusManager',
  'java/awt/MenuComponent',
  'java/awt/Rectangle',
  'java/awt/Toolkit',
  'java/awt/TrayIcon',
  'java/awt/Window',
  'java/awt/event/InputEvent',
  'java/awt/event/KeyEvent',
  'java/awt/event/MouseEvent',
  'java/awt/image/BufferedImage',
  'java/awt/image/ColorModel',
  'java/awt/image/IndexColorModel',
  'java/awt/image/Raster',
  'java/awt/image/SampleModel',
  'java/awt/image/SinglePixelPackedSampleModel',
  'sun/awt/image/ImageRepresentation',
  'sun/java2d/Disposer',
];

export function registerAwtNatives(natives: NativeTable): void {
  const entries: Record<string, NativeFn> = {};
  for (const c of INIT_IDS) entries[`${c}.initIDs()V`] = none;
  natives.register({
    ...entries,
    'java/awt/AWTEvent.nativeSetSource(Ljava/awt/peer/ComponentPeer;)V': none,
    'java/awt/Cursor.finalizeImpl(J)V': none,
    'sun/awt/SunToolkit.closeSplashScreen()V': none,
    'java/awt/SplashScreen._getInstance()J': () => 0n,
  });
}
