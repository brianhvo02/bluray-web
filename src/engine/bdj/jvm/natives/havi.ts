/*
 * HAVi background stills. libbluray leaves HStillImageBackgroundConfiguration.displayImage unimplemented (it keeps
 * the image and rectangle and logs "UNIMPLEMENTED"), so it never shows a disc's background still; a player does.
 * This replaces that method: it keeps the image and rectangle as libbluray's Java does
 * (src/libbluray/bdj/java/org/havi/ui/HStillImageBackgroundConfiguration.java), then reads the still's encoded bytes
 * from where java.awt.BDToolkitBase.createImage(String) put its source (a sun.awt.image.FileImageSource behind the
 * BDImageConsumer that HBackgroundImage(String) holds) and hands them to the host, which shows them under the video.
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ScreenRect } from '../../background';
import type { BdjHost } from '../../host';
import type { NativeResult } from '../interpreter';
import type { Jvm } from '../jvm';
import type { JObject, JValue } from '../values';
import type { NativeTable } from './index';
import { absolute, readVfsFile } from './io';

export const DISPLAY_IMAGE = 'org/havi/ui/HStillImageBackgroundConfiguration.displayImage(Lorg/havi/ui/HBackgroundImage;Lorg/havi/ui/HScreenRectangle;)V';

const CONFIG = 'org/havi/ui/HStillImageBackgroundConfiguration';
const FILE_IMAGE_SOURCE = 'sun/awt/image/FileImageSource';
const IMAGE_CONSUMER = 'java/awt/BDImageConsumer';

/** Where a background image's encoded bytes are: a file of the virtual file system, or none Java code can name. */
type StillSource = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'none' } | { readonly kind: 'unsupported'; readonly what: string };

/** The field `name` of `o`, or undefined when its class has no such instance field. */
function fieldOf(o: JObject, name: string, desc: string): JValue | undefined {
  const f = o.cls.findField(name, desc);
  return f && !f.isStatic ? o.fields[f.slot] : undefined;
}

const isA = (o: JObject, name: string): boolean => {
  for (let c: typeof o.cls | null = o.cls; c; c = c.superClass) if (c.name === name) return true;
  return false;
};

/** HBackgroundImage.img → BDImageConsumer.producer → FileImageSource.imagefile (BDToolkitBase.createImage(String)). */
function sourceOf(jvm: Jvm, image: JObject): StillSource {
  const img = fieldOf(image, 'img', 'Ljava/awt/Image;') as JObject | null | undefined;
  if (!img) return { kind: 'none' }; // HBackgroundImage(byte[]) with null pixels leaves no image
  if (!isA(img, IMAGE_CONSUMER)) return { kind: 'unsupported', what: img.cls.name };
  const producer = fieldOf(img, 'producer', 'Ljava/awt/image/ImageProducer;') as JObject | null | undefined;
  if (!producer) return { kind: 'none' };
  if (!isA(producer, FILE_IMAGE_SOURCE)) return { kind: 'unsupported', what: producer.cls.name };
  const file = jvm.heap.jsString((fieldOf(producer, 'imagefile', 'Ljava/lang/String;') ?? null) as JObject | null);
  return file ? { kind: 'file', path: absolute(file) } : { kind: 'none' };
}

/** HScreenRectangle's public fields; libbluray's default is the whole screen. */
function rectOf(jvm: Jvm, r: JObject | null): ScreenRect {
  if (!r) return { x: 0, y: 0, width: 1, height: 1 };
  const f = (name: string): number => jvm.getField(r, name, 'F') as number;
  return { x: f('x'), y: f('y'), width: f('width'), height: f('height') };
}

export function registerHaviNatives(table: NativeTable, host: BdjHost): void {
  const log = (msg: string): void => host.log(CONFIG, 0, msg, true);
  table.replace({
    [DISPLAY_IMAGE]: (ctx, self, image, r): NativeResult => {
      const jvm = ctx.jvm;
      if (self === null) return jvm.throwNew('java/lang/NullPointerException');
      // libbluray's body, without its "unimplemented" log
      jvm.setField(self as JObject, 'image', 'Lorg/havi/ui/HBackgroundImage;', image);
      jvm.setField(self as JObject, 'rect', 'Lorg/havi/ui/HScreenRectangle;', r);
      const rect = rectOf(jvm, r as JObject | null);
      const show = host.displayImage?.bind(host);
      if (!show) return undefined;
      if (image === null) {
        show(null, rect);
        return undefined;
      }
      const source = sourceOf(jvm, image as JObject);
      if (source.kind === 'none') {
        show(null, rect);
        return undefined;
      }
      if (source.kind === 'unsupported') {
        log(`displayImage(): background images from ${source.what} are not shown`);
        return undefined;
      }
      const vfs = jvm.opts.vfs;
      if (!vfs || vfs.stat(source.path)?.kind !== 'file') {
        log(`displayImage(): ${source.path} cannot be read`);
        return undefined;
      }
      return readVfsFile(vfs, source.path, (bytes) => {
        if (bytes) show(bytes, rect);
        else log(`displayImage(): ${source.path} cannot be read`);
        return undefined;
      });
    },
  });
}
