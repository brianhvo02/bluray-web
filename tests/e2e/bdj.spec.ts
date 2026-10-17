import { expect, test, type Page } from '@playwright/test';
import { bdjStartup, telemetry } from './telemetry';
import { expectBarHidden, expectBarShown } from './support';

// fixtures/synthetic/disc-bdj (scripts/make-bdj-disc.ts): First Play is a BD-J object whose xlet starts TitleXlet,
// which plays playlist 00000 (2 s) and plays it again once it ends; then the player stays 'ended'.
const DISC = 'fixtures/synthetic/disc-bdj';

const notice = (page: Page, text: RegExp) => page.locator('.notice', { hasText: text });

/** Waits for a player state, sampled every animation frame: the disc's playlists are too short for expect's polling. */
async function reachesState(page: Page, state: string, timeout: number): Promise<void> {
  await page.waitForFunction((s) => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === s, state, { polling: 'raf', timeout });
}

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/?telemetry=1${query}`);
  await page.getByTestId('folder-input').setInputFiles(DISC);
}

test("plays the playlist the disc's Java selects, with no picker and no notice", async ({ page }) => {
  await open(page);
  await reachesState(page, 'playing', 30_000);
  await expect(page.getByTestId('player')).toHaveAttribute('data-playlist', '00000'); // the playlist Java selected
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  await expect(notice(page, /menu/)).toHaveCount(0); // 5c's "menu isn't shown yet" is gone
  await expect(page.getByTestId('player')).toHaveAttribute('data-bdj-menu', 'false'); // disc-bdj draws nothing
  await expect.poll(async () => (await bdjStartup(page))?.firstFrameMs ?? null, { timeout: 10_000 }).not.toBeNull();
  const startup = (await bdjStartup(page))!;
  console.log(`disc-bdj start-up: ${JSON.stringify(startup)}`);
  expect(startup.bootMs!).toBeLessThanOrEqual(startup.firstPlaylistMs!);
  expect(startup.firstPlaylistMs!).toBeLessThanOrEqual(startup.firstFrameMs!);
  // Java plays the playlist twice; then playback has ended, still under Java (no picker)
  await reachesState(page, 'ended', 15_000);
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  const t = await telemetry(page);
  expect(t?.framesPresented).toBeGreaterThan(40);
  expect(t?.decoderErrors).toBe(0);
});

test('the picker stays reachable under a BD-J title, and a playlist chosen there plays', async ({ page }) => {
  await open(page);
  await reachesState(page, 'playing', 30_000);
  await page.getByTestId('player').hover();
  await page.getByRole('button', { name: /^(Playlists|Titles)$/ }).click();
  await expect(page.getByTestId('playlist-picker')).toBeVisible();
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  await reachesState(page, 'playing', 15_000);
});

test('a BD-J runtime that cannot boot (?bdjfail=1) falls back to the picker with a notice', async ({ page }) => {
  await open(page, '&bdjfail=1');
  await expect(page.getByTestId('playlist-picker')).toBeVisible({ timeout: 30_000 });
  await expect(notice(page, /^BD-J couldn't start this disc/)).toBeVisible();
  await page.getByTestId('playlist-00000').click();
  await reachesState(page, 'playing', 15_000);
});

// fixtures/synthetic/disc-bdj-menu (scripts/make-bdj-menu-disc.ts): MenuXlet plays playlist 00001 behind a menu of three
// buttons (Play, Chapters, Extras, at x 160-679 and y 360-459, 490-589, 620-719 of the 1920x1080 plane), Play focused.
// A click inside Play changes its text (a MouseListener); Enter on Play hides the menu and plays playlist 00000.
const MENU_DISC = 'fixtures/synthetic/disc-bdj-menu';

/** Clicks the canvas at a point of the 1920x1080 menu plane (the picture is fitted into the canvas, as toMenuSpace). */
async function clickPlane(page: Page, x: number, y: number): Promise<void> {
  const box = (await page.getByTestId('video-canvas').boundingBox())!;
  const scale = Math.min(box.width / 1920, box.height / 1080);
  const left = box.x + (box.width - 1920 * scale) / 2;
  const top = box.y + (box.height - 1080 * scale) / 2;
  await page.mouse.click(left + (x + 0.5) * scale, top + (y + 0.5) * scale);
}

/** The engine's BD-J plane telemetry (?telemetry=1): flushes so far, taps on the menu that brought no reaction, clock. */
async function bdjPlane(page: Page): Promise<{ flushes: number; tapsIgnored: number; clockUs: number } | null> {
  return page.evaluate(() => {
    const t = (window as unknown as { __blurayTelemetry?: { clockUs: number; bdjPlane: { flushes: number; tapsIgnored: number } | null } | null }).__blurayTelemetry;
    return t?.bdjPlane ? { ...t.bdjPlane, clockUs: t.clockUs } : null;
  });
}

/** Waits until the plane has flushed more than `than` times; returns the new count. */
async function flushedPast(page: Page, than: number): Promise<number> {
  await expect.poll(async () => (await bdjPlane(page))?.flushes ?? 0, { timeout: 10_000 }).toBeGreaterThan(than);
  return (await bdjPlane(page))!.flushes;
}

test('a BD-J menu answers clicks on its MouseListener button and keys; a click it ignores offers the remote', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  // the menu's background playlist: 60 s, so Java makes no call at its end while the test runs (a call would count as
  // a reaction to a tap)
  await expect(player).toHaveAttribute('data-playlist', '00001');
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  await expect.poll(async () => (await bdjPlane(page))?.flushes ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const shown = (await bdjPlane(page))!;
  expect(shown.tapsIgnored).toBe(0);

  // Play's MouseListener reacts with a flush; once the player's clock is well past the 0.2 s tap window, the tap was
  // not counted as ignored: no notice, no remote
  await clickPlane(page, 300, 400);
  await flushedPast(page, shown.flushes);
  const clicked = (await bdjPlane(page))!;
  await expect.poll(async () => (await bdjPlane(page))!.clockUs, { timeout: 10_000 }).toBeGreaterThan(clicked.clockUs + 500_000);
  expect((await bdjPlane(page))!.tapsIgnored).toBe(0);
  await expect(notice(page, /doesn't respond to taps/)).toHaveCount(0);
  await expect(page.getByTestId('remote-pad')).toBeHidden();

  // empty plane: the disc ignores the click, so the player says so and opens the remote
  await clickPlane(page, 1400, 540);
  await expect.poll(async () => (await bdjPlane(page))!.tapsIgnored, { timeout: 5_000 }).toBe(1);
  await expect(notice(page, /This disc's menu doesn't respond to taps here\. Use the remote\./)).toBeVisible();
  await expect(page.getByTestId('remote-pad')).toBeVisible();

  // Down moves the focus to Chapters (a repaint), where Enter does nothing: a second of player time later 00001 still
  // plays under the menu. Up goes back to Play (a repaint), where Enter plays 00000.
  const beforeDown = (await bdjPlane(page))!.flushes;
  await page.keyboard.press('ArrowDown');
  await flushedPast(page, beforeDown);
  await page.keyboard.press('Enter');
  const entered = (await bdjPlane(page))!;
  await expect.poll(async () => (await bdjPlane(page))!.clockUs, { timeout: 10_000 }).toBeGreaterThan(entered.clockUs + 1_000_000);
  await expect(player).toHaveAttribute('data-playlist', '00001');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true');
  const beforeUp = (await bdjPlane(page))!.flushes;
  await page.keyboard.press('ArrowUp');
  await flushedPast(page, beforeUp);
  await page.keyboard.press('Enter');
  await expect(player).toHaveAttribute('data-playlist', '00000', { timeout: 10_000 });
  await expect(player).toHaveAttribute('data-bdj-menu', 'false'); // the menu hid itself
});

test('the control bar never covers a BD-J menu: the bottom edge wakes it, a click in its empty space reaches the disc (R9)', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  const player = page.getByTestId('player');
  const bar = page.getByTestId('control-bar');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  await expect.poll(async () => (await bdjPlane(page))?.flushes ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const box = (await player.boundingBox())!;
  const x = box.x + box.width / 2;
  const bottom = box.y + box.height;
  // over the menu the bar hides at once and the cursor stays
  await page.mouse.move(x, box.y + box.height / 2);
  await expectBarHidden(bar, 1_000);
  expect(await player.evaluate((el) => getComputedStyle(el).cursor)).not.toBe('none');
  // the lowest button (Extras, y 620-719) and the menu area below it do not wake the bar
  const scale = Math.min(box.width / 1920, box.height / 1080);
  const top = box.y + (box.height - 1080 * scale) / 2;
  for (const planeY of [670, 760, 900, 1000]) await page.mouse.move(x, top + planeY * scale);
  for (const dy of [60, 40, 26]) await page.mouse.move(x, bottom - dy);
  await page.waitForTimeout(300);
  await expectBarHidden(bar);
  // a click on Play (its MouseListener repaints) does not wake it either
  const shown = (await bdjPlane(page))!;
  await clickPlane(page, 300, 400);
  await flushedPast(page, shown.flushes);
  await expectBarHidden(bar);
  // the bottom 24 px wake it; back over the menu it hides at once
  await page.mouse.move(x, bottom - 10);
  await expectBarShown(bar, 1_000);
  await page.mouse.move(x, box.y + box.height / 2);
  await expectBarHidden(bar, 500);
  // with the bar shown, a click in its empty padding at the bottom edge reaches the disc (which ignores it: nothing is
  // there), so the remote opens; with the remote open the bar stays when the pointer goes back up (Task 8)
  await page.mouse.move(x, bottom - 10);
  await expectBarShown(bar, 1_000);
  const barBox = (await bar.boundingBox())!;
  const pad = { x: barBox.x + 6, y: barBox.y + barBox.height - 4 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null, pad)).toBe('video-canvas');
  const before = (await bdjPlane(page))!.tapsIgnored;
  await page.mouse.click(pad.x, pad.y);
  await expect.poll(async () => (await bdjPlane(page))!.tapsIgnored, { timeout: 5_000 }).toBe(before + 1);
  await expect(page.getByTestId('remote-pad')).toBeVisible();
  await page.mouse.move(x, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await expectBarShown(bar);
  await expect(page.getByTestId('remote-pad')).toBeVisible();
});

test('keys that go to a BD-J menu leave the control bar hidden; a player shortcut shows it (R11)', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  const player = page.getByTestId('player');
  const bar = page.getByTestId('control-bar');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  const shown = await flushedPast(page, 0);
  const box = (await player.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expectBarHidden(bar, 1_000);
  await page.keyboard.press('ArrowDown'); // focus to Chapters: a repaint
  const down = await flushedPast(page, shown);
  await page.keyboard.press('ArrowUp');
  await flushedPast(page, down);
  await page.waitForTimeout(300);
  await expectBarHidden(bar);
  await page.keyboard.press('a'); // cycle audio: a player shortcut
  await expectBarShown(bar, 1_000);
});

test('a click on the video with an empty BD-J plane is play/pause, not a menu click; the remote is offered', async ({ page }) => {
  await open(page);
  await reachesState(page, 'playing', 30_000);
  await expect(page.getByTestId('player')).toHaveAttribute('data-bdj-menu', 'false');
  await page.getByTestId('video-canvas').click();
  await reachesState(page, 'paused', 5_000);
  await expect(notice(page, /doesn't respond to taps/)).toHaveCount(0);
  await page.getByTestId('remote-toggle').click();
  await expect(page.getByTestId('remote-pad')).toBeVisible();
});
