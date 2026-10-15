import { expect, test, type Page } from '@playwright/test';
import { collectWindows, expectInSync } from './telemetry';

// fixtures/synthetic/disc-menu (scripts/make-menu-disc.ts): First Play loops the top menu (playlist 00001). Page 0 has
// buttons A (1, 64x32 at (200, 200), jumps to title 1) and B (2, at (200, 300), opens page 1); page 1 has C (3, at
// (200, 400), back to page 0 on B). Title 1 plays 00000 (time search masked) with a pop-up whose button links to mark 1.
const DISC = 'fixtures/synthetic/disc-menu';

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
  await page.getByTestId('folder-input').setInputFiles(DISC);
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

async function playTitle1(page: Page): Promise<void> {
  await page.getByTestId('player').hover();
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

test('keys move through both pages and start the feature in sync', async ({ page }) => {
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

test('the on-screen remote drives the menu', async ({ page }) => {
  await openMenuDisc(page);
  await page.getByTestId('player').hover();
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
  await openMenuDisc(page);
  await playTitle1(page);
  await page.getByTestId('player').hover();
  await page.getByTestId('play-toggle').click(); // paused: only the button's link to mark 1 can move the clock to 2 s
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
  const paused = (await menuTelemetry(page))!.clockUs;
  expect(paused).toBeLessThan(1_900_000);
  await page.getByTestId('popup').click(); // keyboard focus stays on the control
  await expectMenu(page, true);
  await page.keyboard.press('Enter');
  await expectMenu(page, false);
  await expect.poll(async () => (await menuTelemetry(page))?.clockUs ?? 0, { timeout: 5_000 }).toBeGreaterThanOrEqual(2_000_000);
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
