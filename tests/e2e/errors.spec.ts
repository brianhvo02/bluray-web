import { expect, test } from '@playwright/test';
import { setFolder } from './support';

test('explains when the folder is not a Blu-ray disc', async ({ page }) => {
  await page.goto('/');
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/not-a-disc');
  await expect(page.getByTestId('error')).toContainText('No BDMV folder');
});

test('names the missing files when the STREAM folder is absent', async ({ page }) => {
  await page.goto('/');
  await setFolder(page.getByTestId('folder-input'), 'fixtures/synthetic/partial-disc');
  await expect(page.getByTestId('missing-files')).toContainText('BDMV/STREAM/00001.M2TS');
  await expect(page.getByTestId('playlist-00000')).toBeDisabled();
});
