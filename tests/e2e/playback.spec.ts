import { expect, test, type Page } from '@playwright/test';

const DISC = 'fixtures/synthetic/disc1';
const SYNC_TOLERANCE_US = 20_000;

interface TelemetrySample {
  clockUs: number;
  clockMode: string;
  avOffsetMeanUs: number | null;
  avOffsetMaxAbsUs: number | null;
  framesInWindow: number;
  decoderErrors?: number;
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
async function collectWindows(page: Page, untilUs: number, deadlineMs = 20_000): Promise<TelemetrySample[]> {
  const windows: TelemetrySample[] = [];
  let lastClock = -1;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const t = await telemetry(page);
    if (t && t.clockUs !== lastClock) {
      lastClock = t.clockUs;
      if (t.framesInWindow > 0) windows.push(t);
      if (t.clockUs >= untilUs) return windows;
    }
    if (Date.now() > deadline) throw new Error(`clock stalled at ${lastClock} us (wanted ${untilUs} us)`);
    await page.waitForTimeout(250);
  }
}

const MAX_ABS_TOLERANCE_US = 50_000;

/** Every window must report real offsets (null is not zero) within the mean and jitter bounds. */
function expectInSync(windows: TelemetrySample[]): void {
  let worstMean = 0;
  let worstMax = 0;
  for (const w of windows) {
    expect(w.avOffsetMeanUs).not.toBeNull();
    expect(w.avOffsetMaxAbsUs).not.toBeNull();
    expect(Math.abs(w.avOffsetMeanUs as number)).toBeLessThanOrEqual(SYNC_TOLERANCE_US);
    expect(w.avOffsetMaxAbsUs as number).toBeLessThanOrEqual(MAX_ABS_TOLERANCE_US);
    worstMean = Math.max(worstMean, Math.abs(w.avOffsetMeanUs as number));
    worstMax = Math.max(worstMax, w.avOffsetMaxAbsUs as number);
  }
  console.log(`sync stats: windows=${windows.length} worst|mean|=${worstMean}us worstMaxAbs=${worstMax}us`);
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
  // 'wall' here means the browser has no running audio output (run headed or use a machine with audio).
  for (const w of windows) expect(w.clockMode).toBe('audio');
  expectInSync(windows);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
});

test('skips to the next chapter and is back in sync within a second', async ({ page }) => {
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

test('plays a B-frame, open-GOP disc in sync and seeks without decoder errors', async ({ page }) => {
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
  const clickedAt = Date.now();
  await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
  const after = await collectWindows(page, 3_500_000);
  // Playing on from ~1 s would need 2.5 s of wall time to reach 3.5 s, so this proves a jump.
  expect(Date.now() - clickedAt).toBeLessThan(2200);
  expect(after.length).toBeGreaterThan(0);
  expectInSync(after);
  const seeked = await telemetry(page);
  console.log(`disc2 telemetry (after seek): ${JSON.stringify(seeked)}`);
  expect(seeked?.decoderErrors).toBe(0);
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

test('stays in sync for ten minutes (nightly)', async ({ page }) => {
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
