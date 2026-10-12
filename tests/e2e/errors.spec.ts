import { expect, test } from '@playwright/test';

test('explains when the folder is not a Blu-ray disc', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles('fixtures/synthetic/not-a-disc');
  await expect(page.getByTestId('error')).toContainText('No BDMV folder');
});
