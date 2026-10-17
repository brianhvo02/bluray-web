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
  await skipWithoutH264(page);
  await page.getByTestId('folder-input').setInputFiles('fixtures/synthetic/disc1');
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
});
