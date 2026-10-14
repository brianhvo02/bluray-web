import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayPlane } from '../graphics/overlay-plane';
import { Compositor, fitRect } from './compositor';

describe('fitRect', () => {
  it('letterboxes wide video into a square', () => {
    expect(fitRect(1920, 1080, 1000, 1000)).toEqual({ x: 0, y: 218, width: 1000, height: 563 });
  });

  it('pillarboxes 4:3 into 16:9', () => {
    expect(fitRect(1440, 1080, 1920, 1080)).toEqual({ x: 240, y: 0, width: 1440, height: 1080 });
  });

  it('scales up to fill an exact match', () => {
    expect(fitRect(1280, 720, 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('returns an empty rect for a frame with no size', () => {
    expect(fitRect(0, 1080, 1920, 1080)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('Compositor.drawIg', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fake(width: number, height: number) {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx = (name: string) => new Proxy({}, { get: (_t, prop: string) => (...args: unknown[]) => calls.push([`${name}.${prop}`, ...args]) });
    const igCtx = ctx('ig');
    const mainCtx = ctx('main');
    const igCanvas = { getContext: () => igCtx } as unknown as OffscreenCanvas;
    const main = { width, height, getContext: () => mainCtx } as unknown as OffscreenCanvas;
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    return { calls, compositor: new Compositor(main, () => igCanvas), igCanvas };
  }

  const opaque = (x: number, y: number, w: number, h: number) => ({ cmd: 'draw' as const, pts: -1, x, y, w, h, palette: [{ y: 0, cr: 0, cb: 0, t: 0 }, { y: 100, cr: 128, cb: 128, t: 255 }], img: [{ color: 1, len: w }] });

  it('puts the dirty rect into the IG canvas once and draws it letterboxed over the video', () => {
    const { calls, compositor, igCanvas } = fake(1000, 1000);
    const plane = new OverlayPlane();
    plane.apply({ cmd: 'init', pts: -1, x: 0, y: 0, w: 1920, h: 1080 });
    plane.takeDirty();
    plane.apply(opaque(10, 20, 4, 1));
    compositor.drawIg(plane);
    const puts = calls.filter(([n]) => n === 'ig.putImageData');
    expect(puts).toHaveLength(1);
    const [, image, dx, dy] = puts[0]!;
    expect(image).toMatchObject({ width: 4, height: 1 });
    expect([dx, dy]).toEqual([10, 20]);
    const draws = calls.filter(([n]) => n === 'main.drawImage');
    expect(draws).toEqual([['main.drawImage', igCanvas, 0, 218, 1000, 563]]);
    expect(plane.dirty()).toBeNull();
  });

  it('draws the picture again without copying when nothing changed', () => {
    const { calls, compositor } = fake(1920, 1080);
    const plane = new OverlayPlane();
    plane.apply(opaque(0, 0, 2, 1));
    compositor.drawIg(plane);
    calls.length = 0;
    compositor.drawIg(plane);
    expect(calls.map(([n]) => n)).toEqual(['main.drawImage']);
  });
});
