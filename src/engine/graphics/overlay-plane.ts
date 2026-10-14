/*
 * Overlay command semantics from libbluray src/libbluray/decoders/overlay.h
 * (BD_OVERLAY_*), applied the way a YUV overlay consumer does.
 *
 * Original implementation for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ycrcbToRgba } from './palette';
import type { PgPaletteEntry, RleElem } from './segments';

export type OverlayCmd = 'init' | 'close' | 'clear' | 'draw' | 'wipe' | 'hide' | 'flush';

export interface OverlayOp {
  readonly cmd: OverlayCmd;
  readonly pts: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly palette?: readonly PgPaletteEntry[];
  readonly img?: readonly RleElem[];
  readonly paletteUpdate?: boolean;
}

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/**
 * A fixed-size plane holding one palette entry (Y, Cr, Cb, T) per pixel, row-major,
 * stored as 4 bytes per pixel in exactly that order. All-zero is "empty".
 *
 * apply() semantics (the whole spec, so a C port can match it):
 *  - init, close, clear: set every byte of the plane to 0; the whole plane is dirty.
 *    (init's x/y/w/h are ignored: the plane size is fixed at construction.)
 *  - draw: decode `img` as RLE rows starting at (x, y). A zero-length element at column >= w
 *    ends a line (next line, column 0); one at column < w is ignored; every other element writes `palette[color]` (Y, Cr, Cb, T; an
 *    absent entry is 0,0,0,0) over `len` pixels, REPLACING what was there (no blending,
 *    transparent entries overwrite too). Pixels outside the plane, past column w or past
 *    row h are skipped. Dirty gets (x, y, w, h) clipped to the plane. A draw without
 *    img or palette does nothing.
 *  - paletteUpdate (palette_update_flag): libbluray's graphics controller always sends the
 *    full image and palette with such a draw, so it is applied as an ordinary full redraw
 *    of the rect; the flag is informational only.
 *  - wipe: set all four bytes of every pixel in the clipped rect to 0; rect becomes dirty.
 *  - hide, flush: no pixel changes (hide only says the plane is empty; clear/wipe precede it).
 *
 * hash(): FNV-1a 64-bit (offset basis 0xcbf29ce484222325, prime 0x100000001b3) over the
 * bytes Y, Cr, Cb, T of every pixel in row-major order, printed as 16 lowercase hex digits.
 */
export class OverlayPlane {
  readonly width: number;
  readonly height: number;
  private readonly px: Uint8Array;
  private dirtyRect: Rect | null = null;

  constructor(width = 1920, height = 1080) {
    this.width = width;
    this.height = height;
    this.px = new Uint8Array(width * height * 4);
  }

  apply(op: OverlayOp): void {
    switch (op.cmd) {
      case 'init':
      case 'close':
      case 'clear':
        this.px.fill(0);
        this.markDirty(0, 0, this.width, this.height);
        break;
      case 'draw':
        this.draw(op);
        break;
      case 'wipe':
        this.wipe(op.x, op.y, op.w, op.h);
        break;
      case 'hide':
      case 'flush':
        break;
    }
  }

  dirty(): Rect | null {
    return this.dirtyRect;
  }

  takeDirty(): Rect | null {
    const d = this.dirtyRect;
    this.dirtyRect = null;
    return d;
  }

  /** RGBA (non-premultiplied, ImageData order) for the rect clipped to the plane; only touches the rect. */
  rgba(rect: Rect): Uint8ClampedArray {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(this.width, rect.x + rect.w);
    const y1 = Math.min(this.height, rect.y + rect.h);
    const w = Math.max(0, x1 - x0);
    const h = Math.max(0, y1 - y0);
    const out = new Uint8ClampedArray(w * h * 4);
    const out32 = new Uint32Array(out.buffer);
    let o = 0;
    for (let y = y0; y < y1; y++) {
      let p = (y * this.width + x0) * 4;
      for (let x = x0; x < x1; x++, p += 4) {
        out32[o++] = ycrcbToRgba({ y: this.px[p]!, cr: this.px[p + 1]!, cb: this.px[p + 2]!, t: this.px[p + 3]! });
      }
    }
    return out;
  }

  /** FNV-1a 64 over the raw plane; test and trace use only. */
  hash(): string {
    // 64-bit state as two 32-bit halves; the prime is 2^40 + 0x1b3
    let hi = 0xcbf29ce4;
    let lo = 0x84222325;
    const px = this.px;
    for (let i = 0; i < px.length; i++) {
      lo = (lo ^ px[i]!) >>> 0;
      const loProd = lo * 0x1b3; // < 2^41, exact
      const hiProd = hi * 0x1b3;
      const carry = Math.floor(loProd / 4294967296);
      hi = (hiProd + carry + ((lo << 8) >>> 0)) % 4294967296; // lo << 40 lands in the high half
      lo = loProd % 4294967296;
    }
    return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
  }

  private markDirty(x: number, y: number, w: number, h: number): void {
    const d = this.dirtyRect;
    if (!d) {
      this.dirtyRect = { x, y, w, h };
      return;
    }
    const x0 = Math.min(d.x, x);
    const y0 = Math.min(d.y, y);
    const x1 = Math.max(d.x + d.w, x + w);
    const y1 = Math.max(d.y + d.h, y + h);
    this.dirtyRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  private clip(x: number, y: number, w: number, h: number): Rect | null {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  private wipe(x: number, y: number, w: number, h: number): void {
    const r = this.clip(x, y, w, h);
    if (!r) return;
    for (let row = r.y; row < r.y + r.h; row++) {
      const p = (row * this.width + r.x) * 4;
      this.px.fill(0, p, p + r.w * 4);
    }
    this.markDirty(r.x, r.y, r.w, r.h);
  }

  private draw(op: OverlayOp): void {
    const { img, palette } = op;
    if (!img || !palette) return;
    let row = op.y;
    let col = 0;
    for (const e of img) {
      if (e.len === 0) {
        // end of line once the row is full; a zero-length element earlier in a row (which
        // rle_crop_object can emit) is skipped, as rle_crop_object skips them on input
        if (col >= op.w) {
          row++;
          col = 0;
        }
        continue;
      }
      if (row >= op.y + op.h) break;
      if (row >= 0 && row < this.height) {
        const pe = palette[e.color];
        const end = Math.min(col + e.len, op.w);
        for (let c = col; c < end; c++) {
          const x = op.x + c;
          if (x < 0 || x >= this.width) continue;
          const p = (row * this.width + x) * 4;
          this.px[p] = pe ? pe.y : 0;
          this.px[p + 1] = pe ? pe.cr : 0;
          this.px[p + 2] = pe ? pe.cb : 0;
          this.px[p + 3] = pe ? pe.t : 0;
        }
      }
      col += e.len;
    }
    const r = this.clip(op.x, op.y, op.w, op.h);
    if (r) this.markDirty(r.x, r.y, r.w, r.h);
  }
}
