/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { menuPoint } from './support';

// fixtures/synthetic/disc-bdj-menu (scripts/make-bdj-menu-disc.ts): MenuXlet plays playlist 00001 behind a menu of three
// buttons (Play, Chapters, Extras, at x 160-679 and y 360-459, 490-589, 620-719 of the 1920x1080 plane), Play focused.
// A click inside Play changes its text (a MouseListener); Enter on Play hides the menu and plays playlist 00000.
export const MENU_DISC = 'fixtures/synthetic/disc-bdj-menu';

/** The engine's BD-J plane telemetry (?telemetry=1): flushes, taps on the menu that brought no reaction, settled hash, clock. */
export interface BdjPlaneSample {
  flushes: number;
  tapsIgnored: number;
  hash: string | null;
  clockUs: number;
}

export async function bdjPlane(page: Page): Promise<BdjPlaneSample | null> {
  return page.evaluate(() => {
    const t = (window as unknown as { __blurayTelemetry?: { clockUs: number; bdjPlane: { flushes: number; tapsIgnored: number; hash?: string | null } | null } | null }).__blurayTelemetry;
    return t?.bdjPlane ? { flushes: t.bdjPlane.flushes, tapsIgnored: t.bdjPlane.tapsIgnored, hash: t.bdjPlane.hash ?? null, clockUs: t.clockUs } : null;
  });
}

/** Waits until the plane has flushed more than `than` times; returns the new count. */
export async function flushedPast(page: Page, than: number): Promise<number> {
  await expect.poll(async () => (await bdjPlane(page))?.flushes ?? 0, { timeout: 10_000 }).toBeGreaterThan(than);
  return (await bdjPlane(page))!.flushes;
}

/** Waits until the plane has settled on the hash `want` (telemetry's bdjPlane.hash). */
export async function settlesOn(page: Page, want: string, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await bdjPlane(page))?.hash ?? null, { timeout }).toBe(want);
}

/** Clicks (a touch tap where the page has touch) a point of the 1920x1080 menu plane. */
export async function clickPlane(page: Page, x: number, y: number): Promise<void> {
  const p = await menuPoint(page, x, y);
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  if (touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

/**
 * The plane hashes the libbluray harness settled on at each `wait still` step of a disc-bdj-menu key script
 * (tests/bdj/golden/disc-bdj-menu.<script>.jsonl, made by npm run bdj-trace:golden), in order.
 */
export function goldenSettled(script: 'arrows' | 'mouse'): string[] {
  const lines = readFileSync(new URL(`../bdj/golden/disc-bdj-menu.${script}.jsonl`, import.meta.url), 'utf8').trim().split('\n');
  return lines.flatMap((l) => {
    const e = JSON.parse(l) as { script?: string; step?: string; hash?: string };
    return e.script === 'step' && e.step?.startsWith('wait still') && e.hash ? [e.hash] : [];
  });
}

/** Mean colour (0-255 per channel) of a page region, from a screenshot: what reached the screen, scaled as shown. */
export async function regionColour(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<{ r: number; g: number; b: number }> {
  const png = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i]!;
      g += px[i + 1]!;
      b += px[i + 2]!;
    }
    const n = px.length / 4;
    return { r: r / n, g: g / n, b: b / n };
  }, png);
}

/** The page region of a rectangle of the 1920x1080 menu plane (x0, y0 inclusive; x1, y1 exclusive). */
export async function planeRegion(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const a = await menuPoint(page, x0, y0);
  const b = await menuPoint(page, x1 - 1, y1 - 1);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}
