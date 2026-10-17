/*
 * Original code for bluray-web: an intrinsic for java.awt.image.DirectColorModel.getRGB(int) (a final method) in the
 * sRGB case, which libbluray's image consumers call once per pixel, and the same computation (with
 * IndexColorModel.getRGB(int)) for the loop hooks over whole pixel arrays. It computes what the class library's
 * getAlpha, getRed, getGreen and getBlue (through getsRGBComponentFromsRGB) compute, float operation for float
 * operation, written from the JVM semantics of those methods' bytecode.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JClass } from '../../loader';
import type { JArray, JObject } from '../../values';
import { DECLINE, f2i, perClass, slotOf } from './common';
import type { IntrinsicFn } from './common';

const slots = perClass((cls) => ({
  isSRGB: slotOf(cls, 'is_sRGB', 'Z'),
  supportsAlpha: slotOf(cls, 'supportsAlpha', 'Z'),
  isAlphaPremultiplied: slotOf(cls, 'isAlphaPremultiplied', 'Z'),
  maskArray: slotOf(cls, 'maskArray', '[I'),
  maskOffsets: slotOf(cls, 'maskOffsets', '[I'),
  scaleFactors: slotOf(cls, 'scaleFactors', '[F'),
}));

const fr = Math.fround;

/** DirectColorModel.getsRGBComponentFromsRGB(pixel, idx). */
function component(pixel: number, idx: number, masks: Int32Array, offsets: Int32Array, scale: Float32Array, premultiplied: boolean): number {
  let c = ((pixel & masks[idx]!) >>> offsets[idx]!) | 0;
  if (premultiplied) {
    const a = ((pixel & masks[3]!) >>> offsets[3]!) | 0;
    c = a === 0 ? 0 : f2i(fr(fr(fr(fr(fr(c) * scale[idx]!) * 255) / fr(fr(a) * scale[3]!)) + 0.5));
  } else if (scale[idx] !== 1) {
    c = f2i(fr(fr(fr(c) * scale[idx]!) + 0.5));
  }
  return c;
}

/** DirectColorModel.getRGB as a function of the pixel, when is_sRGB and no pixel can make the bytecode throw. */
function directRGB(cm: JObject): ((pixel: number) => number) | null {
  const fields = cm.fields;
  const s = slots(cm.cls);
  if (fields[s.isSRGB] === 0) return null;
  const supportsAlpha = fields[s.supportsAlpha] !== 0;
  const premultiplied = fields[s.isAlphaPremultiplied] !== 0;
  const masksArr = fields[s.maskArray] as JArray | null;
  const offsetsArr = fields[s.maskOffsets] as JArray | null;
  const scaleArr = fields[s.scaleFactors] as JArray | null;
  if (masksArr === null || offsetsArr === null || scaleArr === null) return null;
  const masks = masksArr.data as Int32Array;
  const offsets = offsetsArr.data as Int32Array;
  const scale = scaleArr.data as Float32Array;
  const needed = supportsAlpha || premultiplied ? 4 : 3;
  if (masks.length < needed || offsets.length < needed || scale.length < needed) return null;
  return (pixel) => {
    let a = 255;
    if (supportsAlpha) {
      a = ((pixel & masks[3]!) >>> offsets[3]!) | 0;
      if (scale[3] !== 1) a = f2i(fr(fr(fr(a) * scale[3]!) + 0.5));
    }
    const r = component(pixel, 0, masks, offsets, scale, premultiplied);
    const g = component(pixel, 1, masks, offsets, scale, premultiplied);
    const b = component(pixel, 2, masks, offsets, scale, premultiplied);
    return (a << 24) | (r << 16) | (g << 8) | b;
  };
}

const indexSlots = perClass((cls) => ({ rgb: slotOf(cls, 'rgb', '[I'), pixelMask: slotOf(cls, 'pixel_mask', 'I') }));

/** IndexColorModel.getRGB(int) (final): rgb[pixel & pixel_mask], when no pixel can index outside rgb. */
function indexRGB(cm: JObject): ((pixel: number) => number) | null {
  const s = indexSlots(cm.cls);
  const rgbArr = cm.fields[s.rgb] as JArray | null;
  const mask = cm.fields[s.pixelMask] as number;
  if (rgbArr === null || mask < 0 || mask >= rgbArr.data.length) return null;
  const rgb = rgbArr.data as Int32Array;
  return (pixel) => rgb[pixel & mask]!;
}

/** Which class library getRGB(int) a ColorModel class runs (by virtual selection): one we compute, or null. */
const getRGBKind = perClass((cls): 'direct' | 'index' | null => {
  let base: JClass | null = cls;
  while (base && base.name !== 'java/awt/image/ColorModel') base = base.superClass;
  const decl = base?.methods.get('getRGB(I)I');
  if (!decl || decl.vtableIndex < 0) return null;
  const selected = cls.vtable[decl.vtableIndex];
  if (selected?.cls.loader !== null) return null;
  if (selected.cls.name === 'java/awt/image/DirectColorModel') return 'direct';
  if (selected.cls.name === 'java/awt/image/IndexColorModel') return 'index';
  return null;
});

/**
 * `cm.getRGB(pixel)` as a function of the pixel, for the colour models whose getRGB(int) we compute and only when no
 * pixel can make it throw; null otherwise (the caller declines).
 */
export function pixelToRGB(cm: JObject): ((pixel: number) => number) | null {
  const kind = getRGBKind(cm.cls);
  return kind === 'direct' ? directRGB(cm) : kind === 'index' ? indexRGB(cm) : null;
}

/** DirectColorModel.getRGB(int pixel) when is_sRGB; declines otherwise, and whenever the bytecode would throw. */
const getRGB: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const f = directRGB(stack[base] as JObject);
  return f === null ? DECLINE : f(stack[base + 1] as number);
};

export const colorModelIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'java/awt/image/DirectColorModel.getRGB(I)I': getRGB,
};
