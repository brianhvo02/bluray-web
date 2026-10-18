import { expect, test, type Locator, type Page } from '@playwright/test';

/** Why a test runs in desktop Chrome only (the A/V sync bounds, audio output, shaders, ASS budgets and real discs are measured there). */
export const CHROME_ONLY = 'measured against desktop Chrome only (A/V sync, audio output, shaders, ASS budgets, real discs)';

/** Skips the running test in Firefox or WebKit when the browser reports no H.264 WebCodecs decoder. Call it with the app loaded, before decoding starts. */
export async function skipWithoutH264(page: Page): Promise<void> {
  const browser = page.context().browser()?.browserType().name();
  if (browser !== 'firefox' && browser !== 'webkit') return;
  const supported = await page.evaluate(() =>
    typeof VideoDecoder === 'undefined'
      ? false
      : VideoDecoder.isConfigSupported({ codec: 'avc1.640028' }).then((s) => s.supported === true).catch(() => false),
  );
  test.skip(!supported, `no H.264 WebCodecs in this ${browser === 'firefox' ? 'Firefox' : 'WebKit'} build`);
}

/** The control bar is hidden: its class within `timeout`, then drawn fully transparent once its 0.2 s fade has run. */
export async function expectBarHidden(bar: Locator, timeout = 5_000): Promise<void> {
  await expect(bar).toHaveClass(/hidden/, { timeout });
  await expect(bar).toHaveCSS('opacity', '0');
}

/** The control bar is shown: its class within `timeout`, then drawn opaque once its 0.2 s fade has run. */
export async function expectBarShown(bar: Locator, timeout = 5_000): Promise<void> {
  await expect(bar).not.toHaveClass(/hidden/, { timeout });
  await expect(bar).toHaveCSS('opacity', '1');
}

/** Page coordinates of a point in the 1920x1080 menu, letterboxed in the canvas as the compositor draws it. */
export async function menuPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('video-canvas').boundingBox())!;
  const scale = Math.min(box.width / 1920, box.height / 1080);
  const width = Math.round(1920 * scale);
  const height = Math.round(1080 * scale);
  const left = box.x + Math.floor((box.width - width) / 2);
  const top = box.y + Math.floor((box.height - height) / 2);
  return { x: left + ((x + 0.5) * width) / 1920, y: top + ((y + 0.5) * height) / 1080 };
}
