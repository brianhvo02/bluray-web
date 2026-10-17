import { expect, test, type Page } from '@playwright/test';
import { CHROME_ONLY, skipWithoutH264 } from './support';
import { collectWindows, expectInSync, telemetry, type TelemetrySample } from './telemetry';

const DISC = 'fixtures/synthetic/disc1';
async function openDisc(page: Page, folder = DISC): Promise<void> {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(folder);
  await expect(page.getByTestId('playlist-00000')).toBeVisible();
}

async function startPlaylist(page: Page, id: string): Promise<void> {
  await skipWithoutH264(page);
  await page.getByTestId(`playlist-${id}`).click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
}

test('lists playlists with the main feature first', async ({ page }) => {
  await openDisc(page);
  await expect(page.getByTestId('playlist-00000')).toContainText('Main feature');
  await expect(page.getByTestId('playlist-00000')).toContainText('0:08');
  await expect(page.getByTestId('playlist-00001')).toContainText('0:04');
});

test('plays in sync across the play-item boundary to the end', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await openDisc(page);
  await startPlaylist(page, '00000');
  const windows = await collectWindows(page, 7_000_000);
  expect(windows.length).toBeGreaterThan(5);
  // 'wall' here means the browser has no running audio output (run headed or use a machine with audio).
  for (const w of windows) expect(w.clockMode).toBe('audio');
  expectInSync(windows);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
});

test('skips to the next chapter and is back in sync within a second', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await openDisc(page);
  await startPlaylist(page, '00000');
  const before = await telemetry(page);
  expect(before).not.toBeNull();
  expect(before?.clockUs).toBeLessThan(1_500_000);
  await page.getByTestId('player').hover();
  await page.getByTestId('next-chapter').click();
  // Ordinary playback would need >1.5 s more to get here, so this proves a jump.
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 1000 }).toBeGreaterThanOrEqual(2_000_000);
  await page.waitForTimeout(1000);
  const windows = await collectWindows(page, 3_500_000);
  expect(windows.length).toBeGreaterThan(0);
  expectInSync(windows);
});

test('opens another disc after closing the current one', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  await page.getByTestId('player').hover();
  await page.getByRole('button', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: 'Open another disc' }).click();
  await expect(page.getByTestId('landing')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('landing')).toBeVisible(); // late events from the old disc must not bring the player back
  await page.getByTestId('folder-input').setInputFiles(DISC);
  await startPlaylist(page, '00000');
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __blurayTelemetry?: { clockUs: number } | null }).__blurayTelemetry?.clockUs)) ?? 0).toBeGreaterThan(1_000_000);
});

test('a key press brings the hidden controls back', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  await page.mouse.move(5, 5);
  await expect(page.getByTestId('control-bar')).toHaveClass(/hidden/, { timeout: 6000 }); // auto-hides after 3 s
  await page.keyboard.press('ArrowUp');
  // Short window: the 8 s fixture ends soon after, and ending also reveals the controls.
  await expect(page.getByTestId('control-bar')).not.toHaveClass(/hidden/, { timeout: 500 });
});

test('pauses and resumes', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5000 }).toBeGreaterThan(500_000);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
  await page.waitForTimeout(300); // let the last pre-pause telemetry sample land
  const pausedSample = await telemetry(page);
  expect(pausedSample).not.toBeNull();
  const paused = (pausedSample as TelemetrySample).clockUs;
  expect(paused).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  const after = await telemetry(page);
  expect(after).not.toBeNull();
  expect(Math.abs((after as TelemetrySample).clockUs - paused)).toBeLessThan(50_000);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5000 }).toBeGreaterThan(paused + 200_000);
});

test('plays a B-frame, open-GOP disc in sync and seeks without decoder errors', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  await openDisc(page, 'fixtures/synthetic/disc2');
  await startPlaylist(page, '00000');
  const windows = await collectWindows(page, 1_000_000);
  expect(windows.length).toBeGreaterThan(1);
  for (const w of windows) expect(w.clockMode).toBe('audio');
  expectInSync(windows);
  const plain = await telemetry(page);
  console.log(`disc2 telemetry (plain playback): ${JSON.stringify(plain)}`);
  expect(plain?.decoderErrors).toBe(0);

  // Seek to 3 s: the nearest earlier entry point is the 2 s open-GOP I-frame (non-IDR, recovery-point SEI).
  await page.getByTestId('player').hover();
  const bar = await page.getByTestId('seek').boundingBox();
  if (!bar) throw new Error('seek bar not found');
  const before = (await telemetry(page))?.clockUs ?? Infinity;
  expect(before).toBeLessThan(2_000_000);
  await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
  // A jump, not ordinary playback: from < 2 s the clock must reach the ~3 s target within 0.7 s.
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 700, intervals: [50] }).toBeGreaterThanOrEqual(2_800_000);
  const after = await collectWindows(page, 3_500_000);
  expect(after.length).toBeGreaterThan(0);
  expectInSync(after);
  const seeked = await telemetry(page);
  console.log(`disc2 telemetry (after seek): ${JSON.stringify(seeked)}`);
  expect(seeked?.decoderErrors).toBe(0);
  expect(seeked?.openGopStarts).toBeGreaterThan(0); // the seek really started on the open-GOP I-frame
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing');
});

test('arrow keys on a focused seek bar seek by 10 s instead of stepping the slider', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  await page.getByTestId('player').hover();
  const bar = await page.getByTestId('seek').boundingBox();
  if (!bar) throw new Error('seek bar not found');
  await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 3000 }).toBeGreaterThanOrEqual(3_900_000);
  await page.keyboard.press('ArrowLeft'); // a native step would land near 3.8 s; the 10 s seek clamps to the start
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 3000 }).toBeLessThan(1_500_000);
});

test('stays in sync for ten minutes (nightly)', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, CHROME_ONLY);
  test.skip(!process.env.NIGHTLY, 'Set NIGHTLY=1 after generating fixtures/local/long-disc (see the README "Nightly sync test" section).');
  test.setTimeout(13 * 60_000);
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles('fixtures/local/long-disc');
  await startPlaylist(page, '00000');
  const windows = await collectWindows(page, 590_000_000, 12 * 60_000);
  expectInSync(windows);
  const mean = (ws: TelemetrySample[]): number => ws.reduce((a, w) => a + (w.avOffsetMeanUs ?? 0), 0) / ws.length;
  expect(Math.abs(mean(windows.slice(-20)) - mean(windows.slice(0, 20)))).toBeLessThan(5_000); // no drift
});

test('holding and slowly dragging the seek bar seeks to where it is released', async ({ page }) => {
  await openDisc(page);
  await startPlaylist(page, '00000');
  await page.getByTestId('player').hover();
  const bar = await page.getByTestId('seek').boundingBox();
  if (!bar) throw new Error('seek bar not found');
  const y = bar.y + bar.height / 2;
  await page.mouse.move(bar.x + bar.width * 0.1, y);
  await page.mouse.down();
  await page.waitForTimeout(3500); // longer than the controls' hide delay
  await expect(page.getByTestId('control-bar')).not.toHaveClass(/hidden/);
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(bar.x + bar.width * (0.1 + (0.6 * i) / 20), y);
    await page.waitForTimeout(50); // slow enough for Chrome to fire a trailing `change` on release
  }
  const released = (await telemetry(page))?.clockUs ?? Infinity;
  expect(released).toBeLessThan(5_000_000); // the drag itself did not seek
  await page.mouse.up();
  // Released at 70% of 8 s: the clock must reach the target and stay past it, not snap back to the old time.
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 1000, intervals: [50] }).toBeGreaterThanOrEqual(5_500_000);
  await page.waitForTimeout(500);
  expect((await telemetry(page))?.clockUs ?? 0).toBeGreaterThanOrEqual(5_500_000);
});
