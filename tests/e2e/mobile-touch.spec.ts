import { expect, test, type Page } from '@playwright/test';
import { telemetry } from './telemetry';
import { bdjPlane, MENU_DISC as BDJ_MENU_DISC } from './bdj-support';
import { expectBarHidden, expectBarShown, menuPoint, skipWithoutH264 } from './support';

const HIDE_CONTROLS_MS = 3000; // PlayerScreen's idle timeout

// Touch input on the video (Pixel 7 emulation, pointerType 'touch').
const MENU_DISC = 'fixtures/synthetic/disc-menu'; // see menus.spec.ts for its layout
const DISC = 'fixtures/synthetic/disc1'; // playlist 00000 is 8 s long

const expectMenu = (page: Page, shown: boolean) => expect(page.getByTestId('player')).toHaveAttribute('data-menu-active', String(shown), { timeout: 5_000 });

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

/** A point `fromBottom` px above the player's bottom edge, centred. */
async function bottomEdge(page: Page, fromBottom: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('player').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height - fromBottom };
}

/** Phone landscape (Pixel 7 turned): the 16:9 picture is pillarboxed and reaches the bottom edge. */
const LANDSCAPE = { width: 839, height: 412 };

/** A point `fromTop` px below the player's top edge, centred. */
async function topEdge(page: Page, fromTop: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('player').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + fromTop };
}

/** Holds a touch at (x, y) for `ms` (Chrome DevTools Protocol touches: pointerType 'touch'); `whileDown` runs before release. */
async function longPress(page: Page, x: number, y: number, ms: number, whileDown?: () => Promise<void>): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  if (whileDown) await whileDown();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('portrait, HDMV menu: a tap in the top or the bottom letterbox brings back the controls that idled out (R13, R14)', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  await expectMenu(page, true);
  const bar = page.getByTestId('control-bar');
  await expectBarHidden(bar, HIDE_CONTROLS_MS + 3_000); // idled out by the timer
  const top = await topEdge(page, 60);
  await page.touchscreen.tap(top.x, top.y);
  await expectBarShown(bar, 1_000);
  await expectMenu(page, true);
  // the bottom letterbox, well above the edge, does it too
  await expectBarHidden(bar, HIDE_CONTROLS_MS + 3_000);
  const low = await bottomEdge(page, 100);
  await page.touchscreen.tap(low.x, low.y);
  await expectBarShown(bar, 1_000);
  // a tap on button A still activates it
  const a = await menuPoint(page, 232, 216);
  await page.touchscreen.tap(a.x, a.y);
  await expectMenu(page, false);
});

test('landscape, HDMV menu: a tap on empty picture brings back the controls; a tap on a button activates it at once (R13)', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE);
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  await expectMenu(page, true);
  const bar = page.getByTestId('control-bar');
  await expectBarHidden(bar, HIDE_CONTROLS_MS + 3_000);
  // a tap on the picture that hits no button is a missed tap, which shows the controls
  const empty = await menuPoint(page, 1400, 540);
  await page.touchscreen.tap(empty.x, empty.y);
  await expectBarShown(bar, 2_000);
  await expectMenu(page, true);
  // with the controls hidden again, one tap on button A activates it
  await expectBarHidden(bar, HIDE_CONTROLS_MS + 3_000);
  const a = await menuPoint(page, 232, 216);
  await page.touchscreen.tap(a.x, a.y);
  await expectMenu(page, false);
});

// fixtures/synthetic/disc-bdj-menu: see bdj-support.ts (Play at x 160-679, y 360-459 of the plane, with a MouseListener)

test('landscape, BD-J menu: a tap on a button reaches the disc at once; an ignored tap brings the remote and the controls (R13)', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE);
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(BDJ_MENU_DISC);
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  await expect.poll(async () => (await bdjPlane(page))?.flushes ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const bar = page.getByTestId('control-bar');
  await expectBarHidden(bar, HIDE_CONTROLS_MS + 3_000);
  // one tap on Play reaches Java (its MouseListener repaints); the controls stay hidden
  const before = (await bdjPlane(page))!.flushes;
  const play = await menuPoint(page, 300, 400);
  await page.touchscreen.tap(play.x, play.y);
  await expect.poll(async () => (await bdjPlane(page))!.flushes, { timeout: 5_000 }).toBeGreaterThan(before);
  await expectBarHidden(bar);
  // a tap on empty picture at the bottom edge goes to Java too, which ignores it: the remote opens with the controls
  const empty = await menuPoint(page, 1400, 1060);
  await page.touchscreen.tap(empty.x, empty.y);
  await expect.poll(async () => (await bdjPlane(page))!.tapsIgnored, { timeout: 5_000 }).toBe(1);
  await expect(page.getByTestId('remote-pad')).toBeVisible();
  await expectBarShown(bar);
});

test('landscape, BD-J menu: a long press shows the controls while held and never reaches Java; a tap still does (R15)', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE);
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(BDJ_MENU_DISC);
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  await expect.poll(async () => (await bdjPlane(page))?.flushes ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const bar = page.getByTestId('control-bar');
  await expectBarHidden(bar, HIDE_CONTROLS_MS + 3_000);
  const before = (await bdjPlane(page))!;
  // a long press on Play: as a tap, its MouseListener would repaint the plane
  const play = await menuPoint(page, 300, 400);
  await longPress(page, play.x, play.y, 800, async () => {
    await expect(bar).not.toHaveClass(/hidden/); // shown at 500 ms, with the finger still down
  });
  await expectBarShown(bar);
  await page.waitForTimeout(1_000);
  const after = (await bdjPlane(page))!;
  expect(after.flushes).toBe(before.flushes); // Java got no click
  expect(after.tapsIgnored).toBe(before.tapsIgnored);
  await expect(page.getByTestId('remote-pad')).toBeHidden();
  // an ordinary tap on Play still reaches Java
  await page.touchscreen.tap(play.x, play.y);
  await expect.poll(async () => (await bdjPlane(page))!.flushes, { timeout: 5_000 }).toBeGreaterThan(before.flushes);
});

test('portrait, BD-J menu: a tap in the bottom letterbox brings back the controls without reaching the disc; a tap on the picture reaches it (R13, R14)', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(BDJ_MENU_DISC);
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  await expect.poll(async () => (await bdjPlane(page))?.flushes ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const bar = page.getByTestId('control-bar');
  await expectBarHidden(bar, HIDE_CONTROLS_MS + 3_000);
  const edge = await bottomEdge(page, 10);
  await page.touchscreen.tap(edge.x, edge.y);
  await expectBarShown(bar, 1_000);
  await page.waitForTimeout(1_000);
  expect((await bdjPlane(page))!.tapsIgnored).toBe(0); // the tap never reached Java
  await expect(page.getByTestId('remote-pad')).toBeHidden();
  // a tap on Play (the picture) reaches Java: its MouseListener repaints
  const before = (await bdjPlane(page))!.flushes;
  const play = await menuPoint(page, 300, 400);
  await page.touchscreen.tap(play.x, play.y);
  await expect.poll(async () => (await bdjPlane(page))!.flushes, { timeout: 5_000 }).toBeGreaterThan(before);
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
