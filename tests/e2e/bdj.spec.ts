import { expect, test, type Page } from '@playwright/test';
import { isLinuxWebKit, LINUX_WEBKIT_REALTIME, setFolder } from './support';
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
  await setFolder(page.getByTestId('folder-input'), DISC);
}

test.beforeEach(({ browserName }) => test.skip(isLinuxWebKit(browserName), LINUX_WEBKIT_REALTIME));

test("plays the playlist the disc's Java selects, with the menu-hidden notice and no picker", async ({ page }) => {
  await open(page);
  await reachesState(page, 'playing', 30_000);
  await expect(page.getByTestId('player')).toHaveAttribute('data-playlist', '00000'); // the playlist Java selected
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
  await expect(notice(page, /menu isn't shown yet/)).toBeVisible();
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
  await expect(notice(page, /menu isn't shown yet/)).toBeHidden(); // BD-J stopped
});

test('a BD-J runtime that cannot boot (?bdjfail=1) falls back to the picker with a notice', async ({ page }) => {
  await open(page, '&bdjfail=1');
  await expect(page.getByTestId('playlist-picker')).toBeVisible({ timeout: 30_000 });
  await expect(notice(page, /^BD-J couldn't start this disc/)).toBeVisible();
  await page.getByTestId('playlist-00000').click();
  await reachesState(page, 'playing', 15_000);
});
