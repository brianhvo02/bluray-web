import { test, type Page } from '@playwright/test';

/** Why a test runs in desktop Chrome only (the A/V sync bounds, audio output, shaders, ASS budgets and real discs are measured there). */
export const CHROME_ONLY = 'measured against desktop Chrome only (A/V sync, audio output, shaders, ASS budgets, real discs)';

/** Why tests that need real-time playback skip in WebKit on Linux: on CI it misses timing windows run after run. */
export const LINUX_WEBKIT_REALTIME = "Linux WebKit (CI, no GPU) can't sustain real-time playback; real Safari is covered by the device test";

/** True in WebKit on Linux, where tests that need real-time playback skip (LINUX_WEBKIT_REALTIME). */
export const isLinuxWebKit = (browserName: string): boolean => browserName === 'webkit' && process.platform === 'linux';

/**
 * Skips the running test in Firefox or WebKit when the browser reports no H.264 WebCodecs decoder, and in WebKit on
 * Linux unless `realtime` is false (the test only needs playback to start). Call it with the app loaded, before
 * decoding starts.
 */
export async function skipWithoutH264(page: Page, { realtime = true }: { realtime?: boolean } = {}): Promise<void> {
  const browser = page.context().browser()?.browserType().name();
  if (browser !== 'firefox' && browser !== 'webkit') return;
  test.skip(realtime && isLinuxWebKit(browser), LINUX_WEBKIT_REALTIME);
  const supported = await page.evaluate(() =>
    typeof VideoDecoder === 'undefined'
      ? false
      : VideoDecoder.isConfigSupported({ codec: 'avc1.640028' }).then((s) => s.supported === true).catch(() => false),
  );
  test.skip(!supported, `no H.264 WebCodecs in this ${browser === 'firefox' ? 'Firefox' : 'WebKit'} build`);
}
