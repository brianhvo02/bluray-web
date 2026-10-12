import { expect, test } from '@playwright/test';

test('app is served cross-origin isolated', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toBeVisible();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});
