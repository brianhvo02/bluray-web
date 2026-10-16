import type { OverlayPlane } from '../graphics/overlay-plane';
import type { TextRenderOptions } from '../subs/text-renderer';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const width = Math.round(srcW * scale);
  const height = Math.round(srcH * scale);
  return { x: Math.floor((dstW - width) / 2), y: Math.floor((dstH - height) / 2), width, height };
}

export interface CompositorLike {
  resize(width: number, height: number): void;
  drawVideo(frame: VideoFrame | null): void;
  /** Draws the PG plane over the video just drawn: call it after every drawVideo, before drawIg. */
  drawPg?(plane: OverlayPlane): void;
  /** Draws text subtitles inside the video rectangle, after drawPg and before drawIg. */
  drawText?(renderer: TextRendererLike, timeUs: number, opts: TextRenderOptions): void;
  /** Draws the IG plane over the video (and PG) just drawn: call it after every drawVideo. */
  drawIg?(plane: OverlayPlane): void;
}

/** A text subtitle renderer (SRT or ASS) as the player and compositor use it. */
export interface TextRendererLike {
  /** Draws inside `videoRect`; returns how many cues or events were drawn. */
  render(ctx: OffscreenCanvasRenderingContext2D, timeUs: number, videoRect: Rect, opts: TextRenderOptions): number;
  /** Whether a render at `timeUs` would differ from the last one. */
  changed(timeUs: number, opts: TextRenderOptions): boolean;
  /** Whether anything shows at `timeUs`. */
  visible(timeUs: number, opts: TextRenderOptions): boolean;
}

/** A plane's pixels at plane size, updated from its dirty rects. */
interface PlaneCanvas { readonly canvas: OffscreenCanvas; readonly ctx: OffscreenCanvasRenderingContext2D; readonly plane: OverlayPlane }

/** Draws planes onto the transferred canvas: video, then the PG overlay, then the IG overlay. */
export class Compositor implements CompositorLike {
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private pg: PlaneCanvas | null = null;
  private ig: PlaneCanvas | null = null;
  /** Display size of the last frame drawn: text is laid out in its fitted rectangle. */
  private frameSize: { readonly width: number; readonly height: number } | null = null;
  /** Storage (coded, visible) size of the last frame: ASS layout follows it for anamorphic video. */
  private storageSize: { readonly width: number; readonly height: number } | null = null;

  constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly createCanvas: (width: number, height: number) => OffscreenCanvas = (w, h) => new OffscreenCanvas(w, h),
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context is unavailable');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    this.canvas.width = Math.max(1, Math.round(width));
    this.canvas.height = Math.max(1, Math.round(height));
  }

  drawVideo(frame: VideoFrame | null): void {
    const { width, height } = this.canvas;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    if (!frame) return;
    this.frameSize = { width: frame.displayWidth, height: frame.displayHeight };
    this.storageSize = { width: frame.visibleRect?.width ?? frame.codedWidth, height: frame.visibleRect?.height ?? frame.codedHeight };
    const r = fitRect(frame.displayWidth, frame.displayHeight, width, height);
    this.ctx.drawImage(frame, r.x, r.y, r.width, r.height);
  }

  drawPg(plane: OverlayPlane): void {
    this.pg = this.drawPlane(this.pg, plane);
  }

  drawIg(plane: OverlayPlane): void {
    this.ig = this.drawPlane(this.ig, plane);
  }

  drawText(renderer: TextRendererLike, timeUs: number, opts: TextRenderOptions): void {
    const f = this.frameSize;
    if (!f) return;
    renderer.render(this.ctx, timeUs, fitRect(f.width, f.height, this.canvas.width, this.canvas.height), { ...opts, storage: opts.storage ?? this.storageSize });
  }

  private drawPlane(held: PlaneCanvas | null, plane: OverlayPlane): PlaneCanvas {
    let pc = held;
    if (!pc || pc.plane !== plane) {
      const canvas = this.createCanvas(plane.width, plane.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context is unavailable');
      pc = { canvas, ctx, plane };
      if (!plane.dirty()) pc.ctx.putImageData(new ImageData(plane.rgba({ x: 0, y: 0, w: plane.width, h: plane.height }), plane.width, plane.height), 0, 0);
    }
    const rect = plane.takeDirty();
    if (rect) {
      const x = Math.max(0, rect.x);
      const y = Math.max(0, rect.y);
      const w = Math.min(plane.width, rect.x + rect.w) - x;
      const h = Math.min(plane.height, rect.y + rect.h) - y;
      if (w > 0 && h > 0) pc.ctx.putImageData(new ImageData(plane.rgba({ x, y, w, h }), w, h), x, y);
    }
    const { width, height } = this.canvas;
    const r = fitRect(plane.width, plane.height, width, height);
    this.ctx.drawImage(pc.canvas, r.x, r.y, r.width, r.height);
    return pc;
  }
}
