import { expect, test } from '@playwright/test';

// The folder input is the pick path only where showDirectoryPicker is missing (Firefox, WebKit); Chrome uses the API.
test.beforeEach(({ browserName }) => test.skip(browserName === 'chromium', 'Chrome picks folders with showDirectoryPicker, not the folder input'));

test('a folder pick that is slow to hand over its files explains the copy, and the notice goes once they arrive', async ({ page }) => {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-folder').click();
  const picker = await chooser;
  await expect(page.getByTestId('copy-notice')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('copy-notice')).toContainText('Safari copies the whole folder');
  await picker.setFiles('fixtures/synthetic/disc1');
  await expect(page.getByTestId('copy-notice')).toBeHidden();
  await expect(page.getByTestId('playlist-00000')).toBeVisible();
});

test('a quick pick never shows the copy notice', async ({ page }) => {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-folder').click();
  await (await chooser).setFiles('fixtures/synthetic/disc1');
  await expect(page.getByTestId('playlist-00000')).toBeVisible();
  await page.waitForTimeout(2000); // past the notice delay
  await expect(page.getByTestId('copy-notice')).toBeHidden();
});
