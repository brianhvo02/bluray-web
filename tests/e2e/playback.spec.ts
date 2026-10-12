import { expect, test, type Page } from '@playwright/test';

const DISC = 'fixtures/synthetic/disc1';
const SYNC_TOLERANCE_US = 20_000;

interface TelemetrySample {
  clockUs: number;
  clockMode: string;
  avOffsetMeanUs: number | null;
  avOffsetMaxAbsUs: number | null;
  framesInWindow: number;
}

async function telemetry(page: Page): Promise<TelemetrySample | null> {
  return page.evaluate(() => (window as unknown as { __blurayTelemetry?: TelemetrySample | null }).__blurayTelemetry ?? null);
}

async function openDisc(page: Page, folder = DISC): Promise<void> {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(folder);
  await expect(page.getByTestId('playlist-00000')).toBeVisible();
}

async function startPlaylist(page: Page, id: string): Promise<void> {
  await page.getByTestId(`playlist-${id}`).click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
}

/** Telemetry windows that presented frames, polled until the clock passes `untilUs`. */
async function collectWindows(page: Page, untilUs: number): Promise<TelemetrySample[]> {
  const windows: TelemetrySample[] = [];
  let lastClock = -1;
  for (;;) {
    const t = await telemetry(page);
    if (t && t.clockUs !== lastClock) {
      lastClock = t.clockUs;
      if (t.framesInWindow > 0) windows.push(t);
      if (t.clockUs >= untilUs) return windows;
    }
    await page.waitForTimeout(250);
  }
}

test('lists playlists with the main feature first', async ({ page }) => {
  await openDisc(page);
  await expect(page.getByTestId('playlist-00000')).toContainText('Main feature');
  await expect(page.getByTestId('playlist-00000')).toContainText('0:08');
  await expect(page.getByTestId('playlist-00001')).toContainText('0:04');
});

test('plays in sync across the play-item boundary to the end', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  const windows = await collectWindows(page, 7_000_000);
  expect(windows.length).toBeGreaterThan(5);
  for (const w of windows) {
    // 'wall' here means the browser has no running audio output (see Step 5).
    expect(w.clockMode).toBe('audio');
    expect(Math.abs(w.avOffsetMeanUs ?? 0)).toBeLessThanOrEqual(SYNC_TOLERANCE_US);
  }
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
});

test('skips to the next chapter and is back in sync within a second', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  await page.getByTestId('player').hover();
  await page.getByTestId('next-chapter').click();
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0).toBeGreaterThanOrEqual(2_000_000);
  await page.waitForTimeout(1000);
  const windows = await collectWindows(page, 3_500_000);
  expect(windows.length).toBeGreaterThan(0);
  for (const w of windows) expect(Math.abs(w.avOffsetMeanUs ?? 0)).toBeLessThanOrEqual(SYNC_TOLERANCE_US);
});

test('pauses and resumes', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
  const paused = (await telemetry(page))?.clockUs ?? 0;
  await page.waitForTimeout(1000);
  expect(Math.abs(((await telemetry(page))?.clockUs ?? 0) - paused)).toBeLessThan(50_000);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
});

test('stays in sync for ten minutes (nightly)', async ({ page }) => {
  test.skip(!process.env.NIGHTLY, 'Set NIGHTLY=1 after generating fixtures/local/long-disc (see Task 20 Step 5).');
  test.setTimeout(13 * 60_000);
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles('fixtures/local/long-disc');
  await startPlaylist(page, '00000');
  const windows = await collectWindows(page, 590_000_000);
  for (const w of windows) expect(Math.abs(w.avOffsetMeanUs ?? 0)).toBeLessThanOrEqual(SYNC_TOLERANCE_US);
  const mean = (ws: TelemetrySample[]): number => ws.reduce((a, w) => a + (w.avOffsetMeanUs ?? 0), 0) / ws.length;
  expect(Math.abs(mean(windows.slice(-20)) - mean(windows.slice(0, 20)))).toBeLessThan(5_000); // no drift
});
