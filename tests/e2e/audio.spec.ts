import { expect, test, type Page } from '@playwright/test';
import { collectWindows, expectInSync, telemetry } from './telemetry';

const DISC = 'fixtures/synthetic/disc3';
const TRACKS = [
  { index: 1, codec: 'LPCM' },
  { index: 2, codec: 'Dolby Digital (AC-3)' },
  { index: 3, codec: 'Dolby TrueHD' },
  { index: 4, codec: 'DTS' },
];

async function seekTo(page: Page, fraction: number): Promise<void> {
  await page.getByTestId('player').hover();
  const bar = await page.getByTestId('seek').boundingBox();
  if (!bar) throw new Error('seek bar not found');
  await page.mouse.click(bar.x + bar.width * fraction, bar.y + bar.height / 2);
}

test('plays every audio track of the disc in sync', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });

  for (const track of TRACKS) {
    await page.getByTestId('player').hover();
    if (track.index !== 1) {
      await page.getByTestId('audio-menu').click();
      await page.getByTestId(`audio-track-${track.index}`).click();
    }
    await seekTo(page, 1 / 12);
    await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
    await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 10_000 }).toBe(track.codec);
    const start = (await telemetry(page))?.clockUs ?? 0;
    const underrunsBefore = (await telemetry(page))?.audioUnderruns ?? 0;
    await page.waitForTimeout(500); // let the switch settle before measuring
    const windows = await collectWindows(page, start + 3_000_000);
    expect(windows.length).toBeGreaterThan(3);
    expectInSync(windows.slice(1));
    const t = await telemetry(page);
    expect(t?.clockMode).toBe('audio');
    expect(t?.audioDecodeErrors).toBe(0);
    expect(t?.audioUnderruns).toBe(underrunsBefore);
  }
});

test('A cycles the audio track and shows which one is playing', async ({ page }) => {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(DISC);
  await page.getByTestId('playlist-00000').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 10_000 });
  await page.keyboard.press('a');
  await expect(page.getByRole('status').filter({ hasText: 'Audio: 2. English · Dolby Digital (AC-3) (multichannel)' })).toBeVisible();
  await expect.poll(async () => (await telemetry(page))?.audioCodec, { timeout: 10_000 }).toBe('Dolby Digital (AC-3)');
});
