import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { collectWindows, expectInSync, telemetry } from './telemetry';

const LOCAL = 'fixtures/local';
const SEEK_FRACTIONS = [0.13, 0.31, 0.52, 0.27, 0.74, 0.08, 0.91, 0.45];

const discs = existsSync(LOCAL) ? readdirSync(LOCAL).filter((name) => existsSync(join(LOCAL, name, 'BDMV'))) : [];

for (const name of discs) {
  test(`seeks around ${name} on the browser's decoder without errors`, async ({ page }) => {
    test.skip(!process.env.LOCAL_DISCS, 'Set LOCAL_DISCS=1 to play the discs under fixtures/local in the browser.');
    test.setTimeout(180_000);
    await page.goto('/?telemetry=1');
    await page.getByTestId('folder-input').setInputFiles(join(LOCAL, name));
    await page.locator('button[data-testid^="playlist-"]:not([disabled])').first().click(); // the main feature is listed first
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
  });
}
