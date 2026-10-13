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
}

/** Draws planes onto the transferred canvas. M1 has the video plane only; PG/IG/text arrive in M3/M4. */
export class Compositor implements CompositorLike {
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  constructor(private readonly canvas: OffscreenCanvas) {
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
}
