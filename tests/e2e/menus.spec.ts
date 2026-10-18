import { expect, test, type Page } from '@playwright/test';
import { CHROME_ONLY, expectBarHidden, expectBarShown, setFolder, skipWithoutH264 } from './support';
import { collectWindows, expectInSync, pausedClockUs, recordTelemetrySamples, telemetrySamples } from './telemetry';

// fixtures/synthetic/disc-menu (scripts/make-menu-disc.ts): First Play loops the top menu (playlist 00001). Page 0 has
// buttons A (1, 64x32 at (200, 200), jumps to title 1) and B (2, at (200, 300), opens page 1); page 1 has C (3, at
// (200, 400), back to page 0 on B). Title 1 plays 00000 (time search masked) with a pop-up whose button links to mark 1.
const DISC = 'fixtures/synthetic/disc-menu';
/** Title 1's playlist has a mark every 2 s. */
const MARK_1_US = 2_000_000;

interface MenuTelemetry {
  clockUs: number;
  menu: { page: number; selectedButton: number; buttonsDrawn: number } | null;
  soundsPlayed: number;
}

async function menuTelemetry(page: Page): Promise<MenuTelemetry | null> {
  return page.evaluate(() => (window as unknown as { __blurayTelemetry?: MenuTelemetry | null }).__blurayTelemetry ?? null);
}

const menuState = async (page: Page): Promise<string> => {
  const m = (await menuTelemetry(page))?.menu;
  return m ? `page ${m.page} button ${m.selectedButton}` : 'none';
};

/** Whether the player shows a disc menu now (the snapshot; telemetry can lag it by one 500 ms interval). */
const expectMenu = (page: Page, shown: boolean) => expect(page.getByTestId('player')).toHaveAttribute('data-menu-active', String(shown), { timeout: 5_000 });

async function openMenuDisc(page: Page): Promise<void> {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await setFolder(page.getByTestId('folder-input'), DISC);
  await expectMenu(page, true);
  await expect.poll(() => menuState(page), { timeout: 10_000 }).toBe('page 0 button 1');
}

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

/**
 * Shows the control bar: over a disc menu only the player's bottom 24 px wake it (ruling R9). The bar then stays while the
 * pointer goes straight onto one of its controls.
 */
async function showControls(page: Page): Promise<void> {
  const box = (await page.getByTestId('player').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
  await expectBarShown(page.getByTestId('control-bar'));
}

/** A point in the control bar's empty padding (bottom left), which belongs to the video and the menu under it. */
async function barPadding(page: Page): Promise<{ x: number; y: number }> {
  const bar = (await page.getByTestId('control-bar').boundingBox())!;
  return { x: bar.x + 6, y: bar.y + bar.height - 4 };
}

async function playTitle1(page: Page): Promise<void> {
  await showControls(page);
  await page.getByTestId('titles').click();
  await page.getByTestId('title-1').click();
  await expect(page.getByTestId('popup')).toBeVisible({ timeout: 5_000 }); // title 1's pop-up is available
  await expectMenu(page, false);
  await expect.poll(() => menuState(page), { timeout: 5_000 }).toBe('none'); // telemetry has caught up with title 1
}

test('opens straight into the disc menu', async ({ page }) => {
  await openMenuDisc(page);
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  expect((await menuTelemetry(page))!.menu!.buttonsDrawn).toBeGreaterThan(0);
  await expect(page.getByTestId('top-menu')).toBeVisible();
});

test('keys move through both pages and start the feature in sync', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await openMenuDisc(page);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => menuState(page)).toBe('page 0 button 2');
  await page.keyboard.press('Enter');
  await expect.poll(() => menuState(page)).toBe('page 1 button 3');
  await page.keyboard.press('Enter');
  await expect.poll(() => menuState(page)).toBe('page 0 button 2');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => menuState(page)).toBe('page 0 button 1');
  await page.keyboard.press('Enter');
  await expectMenu(page, false);
  await expect(page.getByTestId('popup')).toBeVisible({ timeout: 5_000 }); // title 1's pop-up menu is available
  const windows = await collectWindows(page, 4_000_000);
  expect(windows.length).toBeGreaterThan(3);
  expectInSync(windows);
});

test('the mouse selects a button by hovering and activates it by clicking', async ({ page }) => {
  await openMenuDisc(page);
  const b = await menuPoint(page, 232, 316);
  await page.mouse.move(b.x, b.y);
  await expect.poll(() => menuState(page)).toBe('page 0 button 2');
  await expect(page.getByTestId('video-canvas')).toHaveClass(/over-button/);
  const a = await menuPoint(page, 232, 216);
  await page.mouse.click(a.x, a.y);
  await expectMenu(page, false);
  await expect(page.getByTestId('popup')).toBeVisible({ timeout: 5_000 });
});

test('the control bar never covers the menu: only the bottom edge wakes it, it hides at once above, the cursor stays (R9)', async ({ page }) => {
  await openMenuDisc(page);
  const player = page.getByTestId('player');
  const bar = page.getByTestId('control-bar');
  const box = (await player.boundingBox())!;
  const x = box.x + box.width / 2;
  const bottom = box.y + box.height;
  // over the menu the bar hides at once (well inside the 3 s idle timeout) and the cursor stays
  await page.mouse.move(x, box.y + box.height / 2);
  await expectBarHidden(bar, 1_000);
  expect(await player.evaluate((el) => getComputedStyle(el).cursor)).not.toBe('none');
  // the mouse still reaches the menu: hovering B selects it, and the bar stays hidden
  const b = await menuPoint(page, 232, 316);
  await page.mouse.move(b.x, b.y);
  await expect.poll(() => menuState(page)).toBe('page 0 button 2');
  // the lower menu area, where the bar would be, does not wake it
  for (const dy of [160, 100, 60, 40, 26]) await page.mouse.move(x, bottom - dy);
  await page.waitForTimeout(300);
  await expectBarHidden(bar);
  // the bottom 24 px do
  await page.mouse.move(x, bottom - 10);
  await expectBarShown(bar, 1_000);
  // its empty space belongs to the menu underneath
  const pad = await barPadding(page);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null, pad)).toBe('video-canvas');
  // back over the menu it hides at once
  await page.mouse.move(x, box.y + box.height / 2);
  await expectBarHidden(bar, 500);
  // a click on a menu button still activates it
  const a = await menuPoint(page, 232, 216);
  await page.mouse.click(a.x, a.y);
  await expectMenu(page, false);
  // outside the menu any move wakes the bar again
  await page.mouse.move(x, box.y + box.height / 3);
  await expectBarShown(bar, 1_000);
});

test("keys that go to the menu leave the control bar hidden; a player shortcut shows it (R11)", async ({ page }) => {
  await openMenuDisc(page);
  const bar = page.getByTestId('control-bar');
  const box = (await page.getByTestId('player').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expectBarHidden(bar, 1_000);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => menuState(page)).toBe('page 0 button 2');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => menuState(page)).toBe('page 0 button 1');
  await page.waitForTimeout(300);
  await expectBarHidden(bar);
  await page.keyboard.press('a'); // cycle audio: a player shortcut
  await expectBarShown(bar, 1_000);
});

test('the on-screen remote drives the menu', async ({ page }) => {
  await openMenuDisc(page);
  await showControls(page);
  await page.getByTestId('remote-toggle').click();
  await expect(page.getByRole('group', { name: 'Remote control' })).toBeVisible();
  await page.getByTestId('remote-down').click();
  await expect.poll(() => menuState(page)).toBe('page 0 button 2');
  await page.getByTestId('remote-ok').click();
  await expect.poll(() => menuState(page)).toBe('page 1 button 3');
});

test('P opens the pop-up menu during the feature and Enter jumps to mark 1', async ({ page }) => {
  await openMenuDisc(page);
  await playTitle1(page);
  expect((await menuTelemetry(page))!.clockUs).toBeLessThan(1_800_000);
  await page.keyboard.press('p');
  await expectMenu(page, true);
  await expect.poll(() => menuState(page)).toBe('page 0 button 1');
  await page.keyboard.press('Enter');
  await expectMenu(page, false);
  await expect.poll(async () => (await menuTelemetry(page))?.clockUs ?? 0, { timeout: 5_000 }).toBeGreaterThanOrEqual(2_000_000);
});

test('Enter after clicking the Pop-up button activates the pop-up button, not the control again', async ({ page }) => {
  await recordTelemetrySamples(page);
  await openMenuDisc(page);
  await playTitle1(page);
  await page.getByTestId('player').hover();
  const beforePause = (await telemetrySamples(page)).length;
  await page.getByTestId('play-toggle').click(); // paused: only the button's link to mark 1 can move the clock to 2 s
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
  // Wherever a slow browser paused (before or after 2 s), the link moves the paused clock to exactly the mark.
  expect(await pausedClockUs(page, beforePause)).not.toBe(MARK_1_US);
  await page.getByTestId('popup').click(); // keyboard focus stays on the control
  await expectMenu(page, true);
  await page.keyboard.press('Enter');
  await expectMenu(page, false);
  await expect.poll(async () => (await menuTelemetry(page))?.clockUs ?? 0, { timeout: 5_000 }).toBe(MARK_1_US);
});

test('Enter after clicking the Top Menu button activates the selected menu button', async ({ page }) => {
  await openMenuDisc(page);
  await playTitle1(page);
  await page.getByTestId('player').hover();
  await page.getByTestId('top-menu').click(); // keyboard focus stays on the control
  await expectMenu(page, true);
  await expect.poll(() => menuState(page)).toBe('page 0 button 1');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => menuState(page)).toBe('page 0 button 2');
  await page.keyboard.press('Enter'); // B opens page 1; clicking Top Menu again would restart on page 0
  await expect.poll(() => menuState(page)).toBe('page 1 button 3');
});

test('a control the disc masks is disabled and its key explains why', async ({ page }) => {
  await openMenuDisc(page);
  await playTitle1(page);
  await page.getByTestId('player').hover();
  await expect(page.getByTestId('seek')).toBeDisabled();
  await expect(page.getByTestId('seek')).toHaveAttribute('title', "The disc doesn't allow this here");
  const before = (await menuTelemetry(page))!.clockUs;
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('status').filter({ hasText: "The disc doesn't allow this here." })).toBeVisible();
  await page.waitForTimeout(500);
  expect((await menuTelemetry(page))!.clockUs).toBeLessThan(before + 2_000_000); // no 10 s jump
});

test('menu buttons play their sounds', async ({ page }) => {
  await openMenuDisc(page);
  expect((await menuTelemetry(page))!.soundsPlayed).toBe(0);
  await page.keyboard.press('Enter'); // A has an activated sound
  await expect.poll(async () => (await menuTelemetry(page))?.soundsPlayed ?? 0).toBeGreaterThanOrEqual(1);
});
