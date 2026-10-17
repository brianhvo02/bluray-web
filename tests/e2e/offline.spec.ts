import { expect, test } from '@playwright/test';
import { skipWithoutH264 } from './support';

test.use({ serviceWorkers: 'allow' }); // blocked for every other spec in playwright.config.ts

test('plays a disc offline after the first visit', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('app')).toBeVisible();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await skipWithoutH264(page, { realtime: false }); // only checks that playback starts offline
  await page.getByTestId('folder-input').setInputFiles('fixtures/synthetic/disc1');
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
});

for (const status of [404, 502, 503]) {
  test(`serves the cached app when the server answers a navigation with ${status}`, async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', "Playwright routes a service worker's own fetches only in Chromium");
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload(); // now controlled by the service worker
    // a server outage, an error page from a proxy or a CDN: the page itself is cached, so it must still open
    await context.route((url) => url.pathname === '/', (route) => route.fulfill({ status, contentType: 'text/plain', body: `${status} from the network` }));
    await page.reload();
    await expect(page.getByTestId('app')).toBeVisible();
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  });
}
