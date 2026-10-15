import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectWindows, expectInSync, telemetry } from './telemetry';

const LOCAL = 'fixtures/local';
const SEEK_FRACTIONS = [0.13, 0.31, 0.52, 0.27, 0.74, 0.08, 0.91, 0.45];

const FEATURE_MIN_US = 30 * 60 * 1_000_000;

const durationUs = async (page: Page): Promise<number> => Number((await page.getByTestId('seek').getAttribute('max').catch(() => '0')) ?? '0');
const menuShown = async (page: Page): Promise<boolean> => (await page.getByTestId('player').getAttribute('data-menu-active')) === 'true';
/** A long playlist playing with no menu over it (a top menu can loop a long playlist too). */
const featurePlaying = async (page: Page): Promise<boolean> =>
  (await page.getByTestId('player').getAttribute('data-state')) === 'playing' && (await durationUs(page)) > FEATURE_MIN_US && !(await menuShown(page));

/** What a freshly opened disc shows first: the picker (BD-J or no HDMV program), a menu, or playback. */
async function firstScreen(page: Page): Promise<'picker' | 'menu' | 'playing'> {
  let seen: 'picker' | 'menu' | 'playing' | null = null;
  await expect
    .poll(async () => {
      if (await page.getByTestId('playlist-picker').isVisible()) seen = 'picker';
      else if (await menuShown(page)) seen = 'menu';
      else if ((await page.getByTestId('player').getAttribute('data-state')) === 'playing') seen = 'playing';
      return seen;
    }, { timeout: 30_000 })
    .not.toBeNull();
  return seen!;
}

/**
 * An HDMV disc runs its own program: it boots into a menu, or (like TSURUNE) into the feature. Either way, reach the
 * menu (Top Menu if needed), then press Enter up to five times until a playlist longer than 30 minutes plays.
 */
async function hdmvIntoFeature(page: Page, name: string, first: 'menu' | 'playing'): Promise<void> {
  if (first === 'playing') {
    // First Play may show a logo (Menu Call masked) before its program starts the feature
    await expect.poll(() => featurePlaying(page), { timeout: 120_000 }).toBe(true);
    console.log(`${name}: HDMV, boots into the feature (${Math.round((await durationUs(page)) / 60e6)} min playlist); opening the top menu`);
    await page.keyboard.press('m');
  } else {
    console.log(`${name}: HDMV, boots into its menu`);
  }
  await expect.poll(() => menuShown(page), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await telemetry(page) as { menu?: unknown } | null)?.menu ?? null, { timeout: 10_000 }).not.toBeNull();
  for (let presses = 0; presses < 5 && !(await featurePlaying(page)); presses++) {
    await page.waitForTimeout(3000); // let auto-action pages and in-effects settle
    if (await featurePlaying(page)) break;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    console.log(`${name}: Enter ${presses + 1}: menu ${await menuShown(page)}, playlist ${Math.round((await durationUs(page)) / 60e6)} min`);
  }
  await expect.poll(() => featurePlaying(page), { timeout: 30_000 }).toBe(true);
  console.log(`${name}: the menu started the feature`);
}

const discs = existsSync(LOCAL) ? readdirSync(LOCAL).filter((name) => existsSync(join(LOCAL, name, 'BDMV'))) : [];

for (const name of discs) {
  test(`seeks around ${name} on the browser's decoder without errors`, async ({ page }) => {
    test.skip(!process.env.LOCAL_DISCS, 'Set LOCAL_DISCS=1 to play the discs under fixtures/local in the browser.');
    test.setTimeout(300_000);
    await page.goto('/?telemetry=1');
    await page.getByTestId('folder-input').setInputFiles(join(LOCAL, name));
    const first = await firstScreen(page);
    if (first === 'picker') {
      console.log(`${name}: picker (BD-J or no HDMV program)`);
      await page.locator('button[data-testid^="playlist-"]:not([disabled])').first().click(); // the main feature is listed first
    } else {
      await hdmvIntoFeature(page, name, first);
    }
    await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });

    for (const fraction of SEEK_FRACTIONS) {
      await page.getByTestId('player').hover();
      const bar = await page.getByTestId('seek').boundingBox();
      if (!bar) throw new Error('seek bar not found');
      const presented = (await telemetry(page))?.framesPresented ?? 0;
      await page.mouse.click(bar.x + bar.width * fraction, bar.y + bar.height / 2);
      await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
      // New pictures after the seek, not just a still.
      await expect.poll(async () => (await telemetry(page))?.framesPresented ?? 0, { timeout: 10_000 }).toBeGreaterThan(presented + 20);
    }
    const menu = page.getByTestId('audio-menu');
    const trackCount = Number((await page.getByTestId('player').getAttribute('data-audio-tracks')) ?? '0');
    if (trackCount <= 1) {
      console.log(`${name}: single audio track, switching skipped`);
    } else {
      await page.getByTestId('player').hover(); // wake the auto-hidden controls
      await expect(menu).toBeVisible();
      const items = page.locator('[data-testid^="audio-track-"]:not([disabled])');
      await menu.click();
      const count = await items.count();
      const tracks: Array<{ id: string; codec: string }> = [];
      for (let i = 0; i < count; i++) {
        tracks.push({ id: (await items.nth(i).getAttribute('data-testid')) ?? '', codec: (await items.nth(i).getAttribute('data-codec')) ?? '' });
      }
      await page.keyboard.press('Escape');
      expect(count, 'playable audio tracks in the menu').toBeGreaterThanOrEqual(1);
      for (const track of tracks) {
        await page.getByTestId('player').hover();
        await menu.click();
        await page.getByTestId(track.id).click();
        // Same-codec tracks look identical in telemetry, so prove the switch from the menu's checked item.
        await page.getByTestId('player').hover();
        await menu.click();
        await expect(page.getByTestId(track.id)).toHaveAttribute('aria-checked', 'true');
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
        await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 15_000 }).toBe(track.codec);
        await page.waitForTimeout(500);
        const start = (await telemetry(page))?.clockUs ?? 0;
        const windows = await collectWindows(page, start + 4_000_000, 30_000);
        expectInSync(windows.slice(1));
        expect((await telemetry(page))?.audioDecodeErrors, `${track.codec} decode errors`).toBe(0);
        console.log(`${name}: ${track.id} ${track.codec} in sync`);
      }
    }
    const t = await telemetry(page);
    console.log(`${name}: ${JSON.stringify(t)}`);
    expect(t?.decoderErrors).toBe(0);
    expect(t?.audioUnderruns, 'audio underruns').toBe(0);
  });
}
