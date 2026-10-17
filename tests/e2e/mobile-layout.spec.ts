import { expect, test, type Page } from '@playwright/test';

// Small-screen layout (Pixel 7 emulation, touch). The controls container is [data-testid=control-bar] (.control-bar).
const DISC = 'fixtures/synthetic/disc3'; // several audio tracks
const MENU_DISC = 'fixtures/synthetic/disc-menu'; // HDMV: has the Remote toggle
const MIN_TARGET = 44;

async function play(page: Page, disc: string, playlist?: string): Promise<void> {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(disc);
  if (playlist) await page.getByTestId(playlist).click();
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('control-bar')).not.toHaveClass(/hidden/);
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function inViewport(page: Page, testId: string): Promise<void> {
  const box = (await page.locator('[data-testid=control-bar] .audio-menu-list').boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box, testId).toBeTruthy();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
}

for (const size of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test('controls fit the screen and every button is a 44x44 touch target', async ({ page }) => {
      await play(page, DISC, 'playlist-00000');
      expect(await noOverflow(page)).toBe(true);
      const targets = page.locator('[data-testid=control-bar] button:visible, [data-testid=control-bar] input[type=range]:visible');
      const count = await targets.count();
      expect(count).toBeGreaterThan(5);
      for (let i = 0; i < count; i++) {
        const el = targets.nth(i);
        const box = (await el.boundingBox())!;
        const label = await el.evaluate((n) => n.getAttribute('aria-label') ?? n.textContent ?? n.tagName);
        expect(box.width, `${label} width`).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(box.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(box.x, `${label} x`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(size.width + 0.5);
      }
    });

    for (const menu of ['audio-menu', 'subtitle-menu', 'shader-menu']) {
      test(`the ${menu} opens inside the viewport`, async ({ page }) => {
        await play(page, DISC, 'playlist-00000');
        await page.getByTestId(menu).click();
        await expect(page.locator('[data-testid=control-bar] .audio-menu-list')).toBeVisible();
        await inViewport(page, menu);
        expect(await noOverflow(page)).toBe(true);
      });
    }

    test('the Remote toggle is visible and the page does not overflow', async ({ page }) => {
      await play(page, MENU_DISC);
      await expect(page.getByTestId('remote-toggle')).toBeVisible({ timeout: 10_000 });
      const box = (await page.getByTestId('remote-toggle').boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
      expect(await noOverflow(page)).toBe(true);
    });
  });
}
