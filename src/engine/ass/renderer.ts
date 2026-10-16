/*
 * Draws an ASS track on the player canvas: the events active at the playback time, laid out and rasterized as libass
 * does, static events cached as finished bitmaps, collision memory dropped on seeks.
 *
 * Original implementation for bluray-web, 2026; contains no libass, libbluray or FFmpeg code.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { Rect, TextRendererLike } from '../render/compositor';
import type { TextRenderOptions } from '../subs/text-renderer';
import type { AssFonts } from './fonts';
import { FrameBuilder, type FrameEvent } from './frame';
import type { GlyphMeasurer } from './measure';
import { renderEvent, type MaskCache, type RasterContext, type RenderedEvent, type RunMasks } from './raster';
import type { RenderSettings } from './state';
import type { Mat3 } from './transform';
import { YCbCr, type AssTrack, type YCbCrMatrix } from './types';

export interface AssRenderStats { readonly events: number; readonly animated: number; readonly renderMs: number; readonly overBudget: number; readonly renders: number }

export interface AssRendererDeps {
  readonly measurer: GlyphMeasurer;
  readonly createCanvas: (w: number, h: number) => OffscreenCanvas;
  readonly nowMs: () => number;
  readonly Path2D: typeof Path2D;
  /** 'video': convert BT.601 scripts' colours to the BT.709 video, as players do (libass does not); 'none': as written. */
  readonly colorMatrix: 'video' | 'none';
  readonly warp?: (target: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, m: Mat3, originX: number, originY: number) => void;
  /** For tests: replaces the raster. */
  readonly renderEvent?: (rc: RasterContext, ev: FrameEvent, frame: { readonly width: number; readonly height: number }) => RenderedEvent | null;
}

const CACHE_SIZE = 64;
const MASK_CACHE_SIZE = 256;

/** Least recently used run masks (libass bounds its bitmap caches the same way). */
class MaskLru implements MaskCache {
  private readonly map = new Map<string, RunMasks>();
  get(key: string): RunMasks | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, masks: RunMasks): void {
    this.map.set(key, masks);
    if (this.map.size > MASK_CACHE_SIZE) this.map.delete(this.map.keys().next().value!);
  }
  clear(): void {
    this.map.clear();
  }
}
const BUDGET_MS = 8;
const SEEK_MS = 1000;
const ANIMATION_STEP_MS = 40;

const BT601 = { kr: 0.299, kb: 0.114 };
const BT709 = { kr: 0.2126, kb: 0.0722 };

/** A script colour for display: BT.601 (TV.601, PC.601, or no header, as VSFilter assumed) re-encoded as BT.709. */
export function convertColor(c: number, matrix: YCbCrMatrix, mode: 'video' | 'none'): number {
  if (mode === 'none') return c;
  if (matrix !== YCbCr.Default && matrix !== YCbCr.Bt601Tv && matrix !== YCbCr.Bt601Pc) return c;
  const r = (c >>> 24) / 255;
  const g = ((c >>> 16) & 0xff) / 255;
  const b = ((c >>> 8) & 0xff) / 255;
  const y = BT601.kr * r + (1 - BT601.kr - BT601.kb) * g + BT601.kb * b;
  const cb = (b - y) / (2 * (1 - BT601.kb));
  const cr = (r - y) / (2 * (1 - BT601.kr));
  const r2 = y + 2 * (1 - BT709.kr) * cr;
  const b2 = y + 2 * (1 - BT709.kb) * cb;
  const g2 = (y - BT709.kr * r2 - BT709.kb * b2) / (1 - BT709.kr - BT709.kb);
  const q = (v: number): number => Math.min(255, Math.max(0, Math.round(v * 255)));
  return ((q(r2) << 24) | (q(g2) << 16) | (q(b2) << 8) | (c & 0xff)) >>> 0;
}

const sameSettings = (a: RenderSettings | null, b: RenderSettings): boolean =>
  !!a && a.frameWidth === b.frameWidth && a.frameHeight === b.frameHeight && a.storageWidth === b.storageWidth && a.storageHeight === b.storageHeight && a.fontScale === b.fontScale;

export class AssRenderer implements TextRendererLike {
  private builder: FrameBuilder;
  private readonly rc: RasterContext;
  private readonly cache = new Map<number, RenderedEvent | null>();
  private readonly masks = new MaskLru();
  private cacheSettings: RenderSettings | null = null;
  private lastActive = '';
  private lastAnimated = false;
  private lastScale = 1;
  private lastSeenT: number | null = null;
  private lastRenderT = 0;
  private dirty = true;
  private lastStats: AssRenderStats = { events: 0, animated: 0, renderMs: 0, overBudget: 0, renders: 0 };
  private overBudget = 0;
  private renders = 0;

  constructor(private readonly track: AssTrack, private readonly fonts: AssFonts, private readonly deps: AssRendererDeps) {
    this.builder = new FrameBuilder(track, fonts, deps.measurer);
    this.rc = {
      createCanvas: deps.createCanvas,
      Path2D: deps.Path2D,
      masks: this.masks,
      lastShapes: new Map(),
      ...(deps.warp ? { warp: deps.warp } : {}),
      ...(deps.colorMatrix === 'video' ? { mapColor: (c: number) => convertColor(c, track.ycbcrMatrix, 'video') } : {}),
    };
  }

  private static ms(timeUs: number, opts: TextRenderOptions): number {
    return Math.round((timeUs - opts.offsetUs) / 1000);
  }

  private activeKey(t: number): string {
    return this.builder.activeIndices(t).join(',');
  }

  /** Seen every compositor tick: a jump of over a second is a seek, which drops collision memory. */
  private see(t: number): void {
    if (this.lastSeenT !== null && Math.abs(t - this.lastSeenT) > SEEK_MS) this.reset();
    this.lastSeenT = t;
  }

  changed(timeUs: number, opts: TextRenderOptions): boolean {
    const t = AssRenderer.ms(timeUs, opts);
    this.see(t);
    if (this.dirty) return true;
    // animation advances with the video's frames, or every ANIMATION_STEP_MS when none arrive (a still)
    if (this.lastAnimated && Math.abs(t - this.lastRenderT) >= ANIMATION_STEP_MS) return true;
    const key = this.activeKey(t);
    return key !== this.lastActive || (key !== '' && opts.scale !== this.lastScale);
  }

  visible(timeUs: number, opts: TextRenderOptions): boolean {
    return this.builder.activeIndices(AssRenderer.ms(timeUs, opts)).length > 0;
  }

  render(ctx: OffscreenCanvasRenderingContext2D, timeUs: number, videoRect: Rect, opts: TextRenderOptions): number {
    const start = this.deps.nowMs();
    const t = AssRenderer.ms(timeUs, opts);
    const settings: RenderSettings = {
      frameWidth: Math.max(1, Math.round(videoRect.width)),
      frameHeight: Math.max(1, Math.round(videoRect.height)),
      storageWidth: opts.storage?.width ?? Math.round(videoRect.width),
      storageHeight: opts.storage?.height ?? Math.round(videoRect.height),
      fontScale: opts.scale,
    };
    if (!sameSettings(this.cacheSettings, settings)) {
      this.cache.clear();
      this.masks.clear();
      this.cacheSettings = settings;
    }
    const frame = this.builder.build(t, settings);
    if (this.fonts.hasPending()) {
      // faces chosen for this frame were not registered yet: measure again once they are
      void this.fonts.ready().then(() => {
        this.deps.measurer.reset?.();
        this.cache.clear();
        this.masks.clear();
        this.dirty = true;
      });
    }
    const size = { width: settings.frameWidth, height: settings.frameHeight };
    const draw = this.deps.renderEvent ?? renderEvent;
    let animated = 0;
    ctx.save();
    ctx.translate(videoRect.x, videoRect.y);
    for (const ev of frame.events) {
      let r: RenderedEvent | null | undefined;
      if (ev.animated) {
        animated++;
        r = draw(this.rc, ev, size);
      } else {
        r = this.cache.get(ev.index);
        if (r === undefined) {
          r = draw(this.rc, ev, size);
          this.cache.set(ev.index, r);
          if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
        } else {
          // most recently used last
          this.cache.delete(ev.index);
          this.cache.set(ev.index, r);
        }
      }
      if (r) ctx.drawImage(r.canvas, r.x, r.y + ev.shiftY);
    }
    ctx.restore();
    this.lastActive = frame.events.map((e) => e.index).sort((a, b) => a - b).join(',');
    this.lastAnimated = animated > 0;
    this.lastRenderT = t;
    this.lastScale = opts.scale;
    this.dirty = false;
    const renderMs = this.deps.nowMs() - start;
    this.renders++;
    if (renderMs > BUDGET_MS) this.overBudget++;
    this.lastStats = { events: frame.events.length, animated, renderMs, overBudget: this.overBudget, renders: this.renders };
    return frame.events.length;
  }

  /** A seek or offset change: forget collision memory. */
  reset(): void {
    this.builder.reset();
    this.dirty = true;
  }

  /** New fonts: drop layout and bitmap caches. */
  fontsChanged(): void {
    this.deps.measurer.reset?.();
    this.builder = new FrameBuilder(this.track, this.fonts, this.deps.measurer);
    this.cache.clear();
    this.masks.clear();
    this.dirty = true;
  }

  stats(): AssRenderStats {
    return this.lastStats;
  }

  cacheSize(): number {
    return this.cache.size;
  }
}
