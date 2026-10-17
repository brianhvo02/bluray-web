import { test, type Page } from '@playwright/test';

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
