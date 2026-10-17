import { expect, test, type Page } from '@playwright/test';
import { bdjStartup, telemetry } from './telemetry';

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

test('a BD-J menu answers clicks on its MouseListener button and keys; a click it ignores offers the remote', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  await expect(player).toHaveAttribute('data-playlist', '00001'); // the menu's background playlist
  await expect(page.getByTestId('playlist-picker')).toBeHidden();

  // Play's MouseListener reacts (a flush within the tap window): no notice, no remote
  await clickPlane(page, 300, 400);
  await page.waitForTimeout(1000);
  await expect(notice(page, /doesn't respond to taps/)).toHaveCount(0);
  await expect(page.getByTestId('remote-pad')).toBeHidden();

  // empty plane: the disc ignores the click, so the player says so and opens the remote
  await clickPlane(page, 1400, 540);
  await expect(notice(page, /This disc's menu doesn't respond to taps here\. Use the remote\./)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('remote-pad')).toBeVisible();

  // Down moves the focus to Chapters, where Enter does nothing; Up goes back to Play, where Enter plays 00000
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  await expect(player).toHaveAttribute('data-playlist', '00001');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(player).toHaveAttribute('data-playlist', '00000', { timeout: 10_000 });
  await expect(player).toHaveAttribute('data-bdj-menu', 'false'); // the menu hid itself
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
