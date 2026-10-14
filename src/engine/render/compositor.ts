import type { OverlayPlane } from '../graphics/overlay-plane';

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
  /** Draws the IG plane over the video just drawn: call it after every drawVideo. */
  drawIg?(plane: OverlayPlane): void;
}

/** Draws planes onto the transferred canvas: video, then the IG overlay (PG/text arrive in M4). */
export class Compositor implements CompositorLike {
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  /** Holds the IG plane's pixels (plane size), updated from its dirty rects. */
  private ig: { readonly canvas: OffscreenCanvas; readonly ctx: OffscreenCanvasRenderingContext2D; readonly plane: OverlayPlane } | null = null;

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
    const r = fitRect(frame.displayWidth, frame.displayHeight, width, height);
    this.ctx.drawImage(frame, r.x, r.y, r.width, r.height);
  }

  drawIg(plane: OverlayPlane): void {
    let ig = this.ig;
    if (!ig || ig.plane !== plane) {
      const canvas = this.createCanvas(plane.width, plane.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context is unavailable');
      ig = { canvas, ctx, plane };
      this.ig = ig;
      if (!plane.dirty()) ig.ctx.putImageData(new ImageData(plane.rgba({ x: 0, y: 0, w: plane.width, h: plane.height }), plane.width, plane.height), 0, 0);
    }
    const rect = plane.takeDirty();
    if (rect) {
      const x = Math.max(0, rect.x);
      const y = Math.max(0, rect.y);
      const w = Math.min(plane.width, rect.x + rect.w) - x;
      const h = Math.min(plane.height, rect.y + rect.h) - y;
      if (w > 0 && h > 0) ig.ctx.putImageData(new ImageData(plane.rgba({ x, y, w, h }), w, h), x, y);
    }
    const { width, height } = this.canvas;
    const r = fitRect(plane.width, plane.height, width, height);
    this.ctx.drawImage(ig.canvas, r.x, r.y, r.width, r.height);
  }
}
