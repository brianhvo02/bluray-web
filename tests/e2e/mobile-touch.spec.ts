import { expect, test, type Page } from '@playwright/test';
import { telemetry } from './telemetry';
import { expectBarShown, skipWithoutH264 } from './support';

const HIDE_CONTROLS_MS = 3000; // PlayerScreen's idle timeout

// Touch input on the video (Pixel 7 emulation, pointerType 'touch').
const MENU_DISC = 'fixtures/synthetic/disc-menu'; // see menus.spec.ts for its layout
const DISC = 'fixtures/synthetic/disc1'; // playlist 00000 is 8 s long

const expectMenu = (page: Page, shown: boolean) => expect(page.getByTestId('player')).toHaveAttribute('data-menu-active', String(shown), { timeout: 5_000 });

/** Page coordinates of a point in the 1920x1080 menu, letterboxed in the canvas as the compositor draws it. */
async function menuPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('video-canvas').boundingBox())!;
  const scale = Math.min(box.width / 1920, box.height / 1080);
  const width = Math.round(1920 * scale);
  const height = Math.round(1080 * scale);
  const left = box.x + Math.floor((box.width - width) / 2);
  const top = box.y + Math.floor((box.height - height) / 2);
  return { x: left + ((x + 0.5) * width) / 1920, y: top + ((y + 0.5) * height) / 1080 };
}

test('a tap on a menu button activates it', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  await expectMenu(page, true);
  const a = await menuPoint(page, 232, 216);
  await page.touchscreen.tap(a.x, a.y);
  await expectMenu(page, false);
  await expect(page.getByTestId('popup')).toBeVisible({ timeout: 5_000 });
  // A's activated sound plays once per activation: a second click (the browser's synthesized one) would add a sound
  // or, outside the menu, pause the title.
  await page.waitForTimeout(1_000);
  const t = await page.evaluate(() => (window as unknown as { __blurayTelemetry?: { soundsPlayed: number } }).__blurayTelemetry);
  expect(t?.soundsPlayed).toBe(1);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
});

test("the control bar's empty space belongs to the menu under it; a tap there leaves the menu and the bar as they were (R9)", async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  await expectMenu(page, true);
  const bar = page.getByTestId('control-bar');
  await page.keyboard.press('Shift'); // any key shows the controls (for another 3 s)
  await expectBarShown(bar);
  const box = (await bar.boundingBox())!;
  const pad = { x: box.x + 6, y: box.y + box.height - 4 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null, pad)).toBe('video-canvas');
  // the tap goes to the menu (no button there), not to the controls: the bar is not toggled
  await page.touchscreen.tap(pad.x, pad.y);
  await page.waitForTimeout(500);
  await expectMenu(page, true);
  await expectBarShown(bar);
});

test('a double tap on the right third seeks forward', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await page.getByTestId('folder-input').setInputFiles(DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  const before = (await telemetry(page))?.clockUs ?? 0;
  expect(before).toBeLessThan(2_000_000);
  const box = (await page.getByTestId('video-canvas').boundingBox())!;
  const x = box.x + box.width * 0.85;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  // +10 s is clamped to the 8 s playlist: the clock jumps far past ordinary playback within the poll window.
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 1_500, intervals: [50] }).toBeGreaterThanOrEqual(6_000_000);
  // The clamped seek reaches the end of the 8 s playlist; what matters is that the taps never paused it.
  await expect(page.getByTestId('player')).not.toHaveAttribute('data-state', 'paused');
});

// disc1 is 8 s, so this seeks back (a forward seek would end playback and show the controls).
test('a double tap on the left third seeks back while the controls are hidden and leaves them hidden', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await page.getByTestId('folder-input').setInputFiles(DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await expect(page.getByTestId('player')).toHaveClass(/idle/, { timeout: HIDE_CONTROLS_MS + 2_000 });
  const before = (await telemetry(page))?.clockUs ?? 0;
  const box = (await page.getByTestId('video-canvas').boundingBox())!;
  const x = box.x + box.width * 0.15;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? Infinity, { timeout: 2_000 }).toBeLessThanOrEqual(before - 2_000_000);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('player')).toHaveClass(/idle/);
});
