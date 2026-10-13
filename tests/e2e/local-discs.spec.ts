import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const LOCAL = 'fixtures/local';
const SEEK_FRACTIONS = [0.13, 0.31, 0.52, 0.27, 0.74, 0.08, 0.91, 0.45];

interface TelemetrySample {
  clockUs: number;
  decoderErrors: number;
  openGopStarts: number;
  leadingPicturesSkipped: number;
  framesPresented: number;
  audioUnderruns: number;
}

const discs = existsSync(LOCAL) ? readdirSync(LOCAL).filter((name) => existsSync(join(LOCAL, name, 'BDMV'))) : [];

async function telemetry(page: Page): Promise<TelemetrySample | null> {
  return page.evaluate(() => (window as unknown as { __blurayTelemetry?: TelemetrySample | null }).__blurayTelemetry ?? null);
}

for (const name of discs) {
  test(`seeks around ${name} on the browser's decoder without errors`, async ({ page }) => {
    test.skip(!process.env.LOCAL_DISCS, 'Set LOCAL_DISCS=1 to play the discs under fixtures/local in the browser.');
    test.setTimeout(180_000);
    await page.goto('/?telemetry=1');
    await page.getByTestId('folder-input').setInputFiles(join(LOCAL, name));
    await page.locator('[data-testid^="playlist-"]').first().click(); // the main feature is listed first
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
    const t = await telemetry(page);
    console.log(`${name}: ${JSON.stringify(t)}`);
    expect(t?.decoderErrors).toBe(0);
  });
}
