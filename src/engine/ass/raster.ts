/*
 * Draws a laid-out event onto a canvas with libass's compositing: per run a fill mask, a border mask (the fill
 * widened by the border ellipse), blur, the fill cut out of the border, a shadow, colours and karaoke, clips;
 * shadows of all runs first, then borders, then fills. Glyphs are rasterized by the browser.
 *
 * Ported from libass 0.17.5 (ass_render.c): the filter flags of render_and_combine_glyphs, quantize_blur,
 * restore_blur, the composition of ass_composite_construct, render_text, render_glyph (rectangle and karaoke
 * split), blend_vector_clip (as a canvas clip), the BorderStyle 3 box of get_bitmap_glyph; (ass_bitmap.c):
 * ass_fix_outline; (ass_font.c): the strengths of ass_glyph_embolden and ass_glyph_italicize and the decoration
 * rectangles of ass_get_glyph_outline. libass is ISC-licensed; see src/engine/NOTICE. Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { parseDrawing, toPath2D } from './drawing';
import { doubleToD6, lrint, type GlyphInfo } from './events';
import type { FrameEvent } from './frame';
import { DECO_STRIKETHROUGH, DECO_UNDERLINE, EF_KARAOKE, EF_KARAOKE_KF, EF_KARAOKE_KO, type RenderState } from './state';
import { applyFade } from './tags';
import { applyMat3, isAffine, normalize, type Mat3 } from './transform';

export const FILTER_BORDER_STYLE_3 = 0x01;
export const FILTER_NONZERO_BORDER = 0x02;
export const FILTER_NONZERO_SHADOW = 0x04;
export const FILTER_FILL_IN_SHADOW = 0x08;
export const FILTER_FILL_IN_BORDER = 0x10;

const BLUR_PRECISION = 1 / 256;
const POSITION_PRECISION = 8;
const BLUR_RADIUS_SCALE = 2 / Math.sqrt(Math.log(256));

const alpha = (c: number): number => c & 0xff;

/** The filter flags of render_and_combine_glyphs for a run's first glyph. */
export function runFlags(info: Pick<GlyphInfo, 'borderStyle' | 'borderX' | 'borderY' | 'shadowX' | 'shadowY' | 'effectType' | 'fade' | 'c'>): number {
  let flags = 0;
  if (info.borderStyle === 3) flags |= FILTER_BORDER_STYLE_3;
  if (info.borderX || info.borderY) flags |= FILTER_NONZERO_BORDER;
  if (info.shadowX || info.shadowY) flags |= FILTER_NONZERO_SHADOW;
  if (flags & FILTER_NONZERO_SHADOW && (info.effectType === EF_KARAOKE_KF || info.effectType === EF_KARAOKE_KO || alpha(info.c[0]) !== 0xff || info.borderStyle === 3)) flags |= FILTER_FILL_IN_SHADOW;
  if (!(flags & FILTER_NONZERO_BORDER) && !(flags & FILTER_FILL_IN_SHADOW)) flags &= ~FILTER_NONZERO_SHADOW;
  if ((flags & FILTER_NONZERO_BORDER && alpha(info.c[0]) === 0 && alpha(info.c[1]) === 0 && info.fade === 0) || info.borderStyle === 3) flags |= FILTER_FILL_IN_BORDER;
  return flags;
}

/** quantize_blur: the quantisation step and the shadow mask for a radius in px. */
function quantizeBlur(radius: number): { q: number; mask: number } {
  const scale = (64 * BLUR_PRECISION) / POSITION_PRECISION;
  radius *= scale;
  // ord = floor(log2((1 + radius) * POSITION_PRECISION))
  const ord = Math.floor(Math.log2((1 + radius) * POSITION_PRECISION));
  return { q: lrint(Math.log1p(radius) / BLUR_PRECISION), mask: (1 << ord) - 1 };
}

/** restore_blur(quantize_blur(...)): the Gaussian variance (px²) libass blurs with for \blur along one axis. */
export function blurVariance(blur: number, blurScale: number): number {
  const { q } = quantizeBlur(blur * blurScale * BLUR_RADIUS_SCALE);
  const sigma = Math.expm1(BLUR_PRECISION * q) / ((64 * BLUR_PRECISION) / POSITION_PRECISION);
  return sigma * sigma;
}

/** The shadow offset (26.6) rounded to the grid quantize_blur gives for this blur radius (px). */
export function quantizeShadow(shadow26: number, blurRadius: number): number {
  const { mask } = quantizeBlur(blurRadius);
  return (shadow26 + (mask >> 1)) & ~mask;
}

/** ass_fix_outline: the fill cut out of the border. */
export function fixOutline(fill: Uint8Array, border: Uint8Array): void {
  for (let i = 0; i < border.length; i++) {
    const o = border[i]!;
    const g = fill[i]!;
    border[i] = o > g ? o - (g >> 1) : 0;
  }
}

/** 1D squared distance transform (Felzenszwalb), weighted. */
function edt1d(f: Float64Array, n: number, weight: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (f[v[0]!] === Infinity) { v[0] = q; continue; }
    let s: number;
    for (;;) {
      const p = v[k]!;
      s = (f[q]! + weight * q * q - (f[p]! + weight * p * p)) / (2 * weight * (q - p));
      if (s <= z[k]!) {
        if (k === 0) { v[0] = q; s = -Infinity; break; }
        k--;
      } else break;
    }
    if (s === -Infinity) { z[0] = -Infinity; z[1] = Infinity; continue; }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (f[v[0]!] === Infinity) { d.fill(Infinity, 0, n); return; }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = weight * (q - p) * (q - p) + f[p]!;
  }
}

/**
 * The mask widened by an axis-aligned ellipse of radii rx, ry (px): what stroking the outline with round joins
 * covers. A weighted Euclidean distance transform from the pixels at least half covered.
 */
export function dilate(mask: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
  const out = new Uint8Array(mask);
  if (rx <= 0 && ry <= 0) return out;
  const r = Math.max(rx, ry);
  // distances in a metric where the ellipse is a circle of radius r
  const wx = (r / Math.max(rx, 1e-9)) ** 2;
  const wy = (r / Math.max(ry, 1e-9)) ** 2;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i]! >= 128 ? 0 : Infinity;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!;
    edt1d(f, h, wy, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]!;
    edt1d(f, w, wx, d, v, z);
    for (let x = 0; x < w; x++) {
      const dist = Math.sqrt(d[x]!);
      const cov = Math.min(1, Math.max(0, r + 1 - dist));
      const i = y * w + x;
      out[i] = Math.max(out[i]!, Math.round(cov * 255));
    }
  }
  return out;
}

/** What the raster needs from its host: canvases, Path2D, and the projective warp for 3D-rotated runs. */
export interface RasterContext {
  createCanvas(w: number, h: number): OffscreenCanvas;
  readonly Path2D: typeof Path2D;
  /** Draws `source` (laid out in layout space, origin at the run's first glyph) onto `target` through `m`; `origin` is where target's (0,0) is on the frame. */
  warp?(target: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, m: Mat3, originX: number, originY: number): void;
}

interface Layer { x: number; y: number; w: number; h: number; data: ImageData }
interface RunLayers { shadow: Layer | null; border: Layer | null; fill: Layer | null }

type Affine = [number, number, number, number, number, number];

/** The canvas transform taking a glyph's local text px (at its em size) to device px through m and its outline transform. */
function glyphAffine(m: Mat3, g: GlyphInfo): Affine {
  const sx = g.trScaleX;
  const sy = g.trScaleY;
  const ox = g.trOffsetX;
  const oy = g.trOffsetY;
  // local px → outline 26.6 is ×64; outline → layout is (s·o + offset); m maps layout 26.6 to device 26.6
  const a = m[0] * sx;
  const b = m[3] * sx;
  const c = m[1] * sy;
  const d = m[4] * sy;
  const e = (m[0] * ox + m[1] * oy + m[2]) / 64;
  const f = (m[3] * ox + m[4] * oy + m[5]) / 64;
  return [a, b, c, d, e, f];
}

/** Draws one glyph's fill (text, synthetic bold, decorations, or drawing) in white at the current transform. */
function drawGlyph(ctx: OffscreenCanvasRenderingContext2D, g: GlyphInfo, rc: RasterContext): void {
  if (g.drawingText !== null) {
    const d = g.drawing ?? parseDrawing(g.drawingText);
    ctx.fill(toPath2D(d, (x, y) => [x / 64, y / 64], rc.Path2D), 'nonzero');
    return;
  }
  const face = g.face;
  if (!face) return;
  const em = g.emPx;
  if (face.synthItalic) ctx.transform(1, 0, -face.italicShear, 1, 0, 0);
  ctx.font = `${em}px "${face.cssFamily}"`;
  ctx.fontKerning = 'none';
  const text = g.clusterText ?? String.fromCodePoint(g.symbol);
  ctx.fillText(text, 0, 0);
  if (face.synthBold) {
    ctx.lineWidth = em / 64;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 0);
  }
  const f = face.face;
  const k = em / f.unitsPerEm;
  const adv = Math.round(g.metrics?.advance ?? 0);
  if (adv > 0 && g.flags & DECO_UNDERLINE && f.underlinePosition <= 0 && f.underlineThickness > 0) {
    const size = Math.round(f.underlineThickness * k * 64) / 64;
    ctx.fillRect(0, -f.underlinePosition * k - size / 2, adv, size);
  }
  if (adv > 0 && g.flags & DECO_STRIKETHROUGH && f.strikeoutPosition >= 0 && f.strikeoutSize > 0) {
    const size = Math.round(f.strikeoutSize * k * 64) / 64;
    ctx.fillRect(0, -f.strikeoutPosition * k - size / 2, adv, size);
  }
}

/** The BorderStyle 3 box of a glyph, as get_bitmap_glyph builds it, in layout 26.6 relative to the glyph. */
function boxRect(s: RenderState, g: GlyphInfo): [number, number, number, number] {
  let bx = (64 * g.borderX * s.borderScaleX) / s.parScaleX;
  let by = 64 * g.borderY * s.borderScaleY;
  let width = g.hspacingScaled + g.advanceX;
  let height = g.asc + g.desc;
  const osx = g.scaleX * g.scaleFix;
  const osy = g.scaleY * g.scaleFix;
  // VSFilter's double scaling of the opaque box
  bx *= osx;
  by *= osy;
  width *= osx;
  height *= osy;
  bx = Math.max(64, bx);
  by = Math.max(64, by);
  // the unit box (0..64) scaled by (size/64) in outline units, then the outline transform (trScale) applies
  const x0 = -bx * g.trScaleX;
  const y0 = (-by - g.asc) * g.trScaleY;
  return [x0, y0, x0 + (width + 2 * bx) * g.trScaleX, y0 + (height + 2 * by) * g.trScaleY];
}

function readAlpha(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[4 * i + 3]!;
  return out;
}

/** A Gaussian blur of an alpha mask, by the canvas filter. */
function blur(rc: RasterContext, mask: Uint8Array, w: number, h: number, sigma: number): Uint8Array {
  if (sigma < 0.03) return mask;
  const src = rc.createCanvas(w, h);
  const sctx = src.getContext('2d')!;
  const img = sctx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = 255;
    img.data[4 * i + 3] = mask[i]!;
  }
  sctx.putImageData(img, 0, 0);
  const dst = rc.createCanvas(w, h);
  const dctx = dst.getContext('2d')!;
  dctx.filter = `blur(${sigma}px)`;
  dctx.drawImage(src, 0, 0);
  return readAlpha(dctx, w, h);
}

function colorize(mask: Uint8Array, w: number, h: number, color: (x: number) => number, x0: number, y0: number): Layer {
  const data = new ImageData(w, h);
  const d = data.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = mask[i]!;
      if (!m) continue;
      const c = color(x0 + x);
      d[4 * i] = c >>> 24;
      d[4 * i + 1] = (c >>> 16) & 0xff;
      d[4 * i + 2] = (c >>> 8) & 0xff;
      d[4 * i + 3] = Math.round((m * (255 - (c & 0xff))) / 255);
    }
  }
  return { x: x0, y: y0, w, h, data };
}

/** Renders a run's shadow, border and fill layers in device space. */
function renderRun(rc: RasterContext, ev: FrameEvent, idx: readonly number[]): RunLayers {
  const s = ev.layout.text.state;
  const glyphs = idx.map((i) => ev.layout.text.glyphs[i]!);
  const mats = idx.map((i) => normalize(ev.matrices[i]!));
  const first = glyphs[0]!;
  const flags = runFlags(first);
  const c = first.c.map((v) => applyFade(v, first.fade));

  // border ellipse in layout 26.6 (get_bitmap_glyph), mapped to device px by the first glyph's matrix
  const bx26 = (64 * s.borderScaleX * first.borderX) / s.parScaleX;
  const by26 = 64 * s.borderScaleY * first.borderY;
  const m0 = mats[0]!;
  const rx = Math.hypot(m0[0] * bx26, m0[3] * bx26) / 64;
  const ry = Math.hypot(m0[1] * by26, m0[4] * by26) / 64;
  const r2x = blurVariance(first.blur, s.blurScaleX);
  const r2y = blurVariance(first.blur, s.blurScaleY);
  const sigma = Math.sqrt((r2x + r2y) / 2 + 0.5 * first.be);
  const shadow26X = quantizeShadow(doubleToD6(first.shadowX * s.borderScaleX), first.blur * s.blurScaleX * BLUR_RADIUS_SCALE);
  const shadow26Y = quantizeShadow(doubleToD6(first.shadowY * s.borderScaleY), first.blur * s.blurScaleY * BLUR_RADIUS_SCALE);

  // device bounding box of the run's glyph boxes (and BorderStyle 3 boxes), padded for border, blur and shadow
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (m: Mat3, x: number, y: number): void => {
    const [px, py] = applyMat3(m, x, y);
    minX = Math.min(minX, px / 64); maxX = Math.max(maxX, px / 64);
    minY = Math.min(minY, py / 64); maxY = Math.max(maxY, py / 64);
  };
  glyphs.forEach((g, k) => {
    const m = mats[k]!;
    const boxes: [number, number, number, number][] = [[g.bboxXMin, g.bboxYMin, g.bboxXMax, g.bboxYMax]];
    if (flags & FILTER_BORDER_STYLE_3) boxes.push(boxRect(s, g));
    for (const [x0, y0, x1, y1] of boxes) {
      extend(m, x0, y0); extend(m, x1, y0); extend(m, x0, y1); extend(m, x1, y1);
    }
  });
  if (!Number.isFinite(minX)) return { shadow: null, border: null, fill: null };
  const pad = Math.ceil(Math.max(rx, ry) + 3 * sigma + 3);
  const ox = Math.floor(minX) - pad;
  const oy = Math.floor(minY) - pad;
  const w = Math.ceil(maxX) + pad - ox;
  const h = Math.ceil(maxY) + pad - oy;
  if (w <= 0 || h <= 0 || w * h > 4096 * 4096) return { shadow: null, border: null, fill: null };

  const fillCanvas = rc.createCanvas(w, h);
  const fctx = fillCanvas.getContext('2d')!;
  fctx.fillStyle = '#fff';
  fctx.strokeStyle = '#fff';
  const affine = mats.every(isAffine);
  if (affine || !rc.warp) {
    glyphs.forEach((g, k) => {
      const t = glyphAffine(mats[k]!, g);
      fctx.setTransform(t[0], t[1], t[2], t[3], t[4] - ox, t[5] - oy);
      drawGlyph(fctx, g, rc);
    });
  } else {
    // 3D rotation: draw in layout space around the first glyph, then warp to the frame
    const lw = Math.ceil(w * 2 + 64);
    const layout = rc.createCanvas(lw, lw);
    const lctx = layout.getContext('2d')!;
    lctx.fillStyle = '#fff';
    lctx.strokeStyle = '#fff';
    const half = lw / 2;
    glyphs.forEach((g) => {
      const dx = (g.shiftX - first.shiftX) / 64;
      const dy = (g.shiftY - first.shiftY) / 64;
      lctx.setTransform(g.trScaleX, 0, 0, g.trScaleY, half + dx + g.trOffsetX / 64, half + dy + g.trOffsetY / 64);
      drawGlyph(lctx, g, rc);
    });
    const shifted: Mat3 = [m0[0], m0[1], m0[2] - 64 * half * m0[0] - 64 * half * m0[1], m0[3], m0[4], m0[5] - 64 * half * m0[3] - 64 * half * m0[4], m0[6], m0[7], m0[8] - 64 * half * m0[6] - 64 * half * m0[7]];
    rc.warp(fctx, layout, shifted, ox, oy);
  }
  let fill = readAlpha(fctx, w, h);

  let border: Uint8Array | null = null;
  if (flags & FILTER_BORDER_STYLE_3) {
    if (flags & (FILTER_NONZERO_BORDER | FILTER_NONZERO_SHADOW)) {
      const bc = rc.createCanvas(w, h);
      const bctx = bc.getContext('2d')!;
      bctx.fillStyle = '#fff';
      glyphs.forEach((g, k) => {
        const [x0, y0, x1, y1] = boxRect(s, g);
        const m = mats[k]!;
        bctx.beginPath();
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) {
          const [px, py] = applyMat3(m, x, y);
          bctx.lineTo(px / 64 - ox, py / 64 - oy);
        }
        bctx.fill();
      });
      border = readAlpha(bctx, w, h);
    }
  } else if (flags & FILTER_NONZERO_BORDER) {
    border = dilate(fill, w, h, rx, ry);
  }

  // ass_synth_blur: the fill only without a border (or for the opaque box), the border always
  if (!(flags & FILTER_NONZERO_BORDER) || flags & FILTER_BORDER_STYLE_3) fill = blur(rc, fill, w, h, sigma);
  if (border) border = blur(rc, border, w, h, sigma);

  if (border && !(flags & FILTER_FILL_IN_BORDER) && !(flags & FILTER_FILL_IN_SHADOW)) fixOutline(fill, border);
  let shadow: Uint8Array | null = null;
  if (flags & FILTER_NONZERO_SHADOW) {
    if (flags & FILTER_NONZERO_BORDER && border) {
      shadow = new Uint8Array(border);
      if (flags & FILTER_FILL_IN_BORDER && !(flags & FILTER_FILL_IN_SHADOW)) fixOutline(fill, shadow);
    } else if (flags & FILTER_BORDER_STYLE_3) {
      shadow = border;
      border = null;
    } else {
      shadow = new Uint8Array(fill);
    }
  }
  if (border && flags & FILTER_FILL_IN_SHADOW && !(flags & FILTER_FILL_IN_BORDER)) fixOutline(fill, border);

  // colours: render_text
  const type = first.effectType;
  const kTiming = first.effectTiming;
  let fillColor: (x: number) => number = () => c[0]!;
  if (type === EF_KARAOKE || type === EF_KARAOKE_KO) fillColor = () => (kTiming > 0 ? c[0]! : c[1]!);
  else if (type === EF_KARAOKE_KF) {
    const brk = kfBreak(glyphs, mats, first, s.parScaleX);
    fillColor = (x) => (x < brk ? c[0]! : c[1]!);
  }
  const shadowLayer = shadow ? colorize(shadow, w, h, () => c[3]!, ox, oy) : null;
  if (shadowLayer) {
    shadowLayer.x += shadow26X / 64;
    shadowLayer.y += shadow26Y / 64;
  }
  const borderLayer = border && !(type === EF_KARAOKE_KO && kTiming <= 0) ? colorize(border, w, h, () => c[2]!, ox, oy) : null;
  return { shadow: shadowLayer, border: borderLayer, fill: colorize(fill, w, h, fillColor, ox, oy) };
}

/** render_and_combine_glyphs' \kf split: the run's leftmost transformed x plus the sweep distance, device px. */
export function kfBreak(glyphs: readonly GlyphInfo[], mats: readonly Mat3[], first: GlyphInfo, parScaleX: number): number {
  let leftmost = Infinity;
  glyphs.forEach((g, k) => {
    for (const [x, y] of [[g.bboxXMin, g.bboxYMin], [g.bboxXMin, g.bboxYMax], [g.bboxXMax, g.bboxYMin], [g.bboxXMax, g.bboxYMax]] as const) {
      leftmost = Math.min(leftmost, applyMat3(mats[k]!, x, y)[0]);
    }
  });
  if (!Number.isFinite(leftmost)) leftmost = 0;
  const v = leftmost / 64 + (first.effectTiming / 64) * parScaleX;
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/** The runs of an event as render_and_combine_glyphs splits them: indices of their visible glyphs. */
export function eventRuns(ev: FrameEvent): number[][] {
  const runs: number[][] = [];
  let newRun = true;
  ev.layout.text.glyphs.forEach((g, i) => {
    if (g.startsNewRun) newRun = true;
    if (g.skip || !ev.matrices[i]) return;
    if (newRun) runs.push([]);
    newRun = false;
    runs.at(-1)!.push(i);
  });
  return runs;
}

/** Applies the event's clip (rectangle and/or vector, normal or inverse) to ctx, which the caller saves and restores. */
function applyClip(ctx: OffscreenCanvasRenderingContext2D, rc: RasterContext, ev: FrameEvent, frame: { width: number; height: number }): void {
  const l = ev.layout;
  const s = l.text.state;
  const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));
  const x0 = clamp(l.clip.x0, frame.width);
  const y0 = clamp(l.clip.y0, frame.height);
  const x1 = clamp(l.clip.x1, frame.width);
  const y1 = clamp(l.clip.y1, frame.height);
  const rect = new rc.Path2D();
  if (l.clip.mode) {
    rect.rect(0, 0, frame.width, frame.height);
    rect.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip(rect, 'evenodd');
  } else {
    rect.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip(rect);
  }
  if (l.clip.drawing !== null) {
    const base = (1 << ((l.clip.drawingScale - 1) & 31)) | 0;
    const wscale = base > 0 ? 1 / base : 0;
    const d = parseDrawing(l.clip.drawing);
    const path = toPath2D(d, (x, y) => [(x * s.screenScaleX * wscale) / 64, (y * s.screenScaleY * wscale) / 64], rc.Path2D);
    if (l.clip.drawingMode) {
      const inv = new rc.Path2D();
      inv.rect(0, 0, frame.width, frame.height);
      inv.addPath(path);
      ctx.clip(inv, 'evenodd');
    } else {
      ctx.clip(path, 'nonzero');
    }
  }
}

/** Draws one laid-out event onto ctx (device px, frame origin at 0,0): shadows, then borders, then fills. */
export function drawEvent(ctx: OffscreenCanvasRenderingContext2D, rc: RasterContext, ev: FrameEvent, frame: { readonly width: number; readonly height: number }): void {
  const runs = eventRuns(ev).map((idx) => renderRun(rc, ev, idx));
  ctx.save();
  // collision handling moves the finished images, clip included (shift_event)
  ctx.translate(0, ev.shiftY);
  applyClip(ctx, rc, ev, frame);
  const scratch: { canvas: OffscreenCanvas | null } = { canvas: null };
  const put = (layer: Layer | null): void => {
    if (!layer) return;
    if (!scratch.canvas || scratch.canvas.width < layer.w || scratch.canvas.height < layer.h) {
      scratch.canvas = rc.createCanvas(Math.max(layer.w, scratch.canvas?.width ?? 0), Math.max(layer.h, scratch.canvas?.height ?? 0));
    }
    const sctx = scratch.canvas.getContext('2d')!;
    sctx.clearRect(0, 0, layer.w, layer.h);
    sctx.putImageData(layer.data, 0, 0);
    ctx.drawImage(scratch.canvas, 0, 0, layer.w, layer.h, layer.x, layer.y, layer.w, layer.h);
  };
  if (ev.layout.text.state.borderStyle !== 4) for (const r of runs) put(r.shadow);
  for (const r of runs) put(r.border);
  for (const r of runs) put(r.fill);
  ctx.restore();
}
