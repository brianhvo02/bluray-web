import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { scanPg } from '../helpers/pg-scan';
import { collectWindows, expectInSync, telemetry } from './telemetry';
import { CHROME_ONLY } from './support';

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, CHROME_ONLY);

const LOCAL = 'fixtures/local';
const SEEK_FRACTIONS = [0.13, 0.31, 0.52, 0.27, 0.74, 0.08, 0.91, 0.45];

const FEATURE_MIN_US = 30 * 60 * 1_000_000;
const SUBTITLE_SEEKS = [0.1, 0.35, 0.6];
const SUBTITLE_WAIT_MS = 30_000;
/** A subtitle is expected after a seek when the disc has one starting this soon after the landing point. */
const SUBTITLE_EXPECTED_US = 25_000_000;

interface PgTelemetry { pg: { objectsShown: number; forced: number } | null; pgErrors: number }
const pgTelemetry = async (page: Page): Promise<PgTelemetry | null> => (await telemetry(page)) as unknown as PgTelemetry | null;

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
    test.setTimeout(900_000);
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
    await checkPgTracks(page, name);
    const t = await telemetry(page);
    console.log(`${name}: ${JSON.stringify(t)}`);
    expect(t?.decoderErrors).toBe(0);
    expect(t?.audioUnderruns, 'audio underruns').toBe(0);
  });
}

/**
 * Every PG track of the feature: picked from the menu, then seeks to 10, 35 and 60 %. Where the disc has a subtitle starting
 * within 25 s after the landing point (found by decoding the streams in Node, scanPg), it must be drawn within 30 s. Sparse
 * tracks (foreign-dialogue-only, commentary) often have none near a seek point; those seeks are logged, not failed.
 */
async function checkPgTracks(page: Page, name: string): Promise<void> {
  const scan = await scanPg(join(LOCAL, name), await durationUs(page));
  if (!scan) throw new Error(`${name}: no playlist with the playing duration`);
  for (const [stream, s] of Object.entries(scan.streams)) {
    console.log(`${name}: PG ${stream} (${s.language}) on disc: ${s.objectTimesUs.length} subtitles, ${s.errors} decode errors`);
    expect(s.errors, `PG ${stream} decode errors on disc`).toBe(0);
  }
  const menu = page.getByTestId('subtitle-menu');
  await page.getByTestId('player').hover();
  await menu.click();
  const items = page.locator('[data-testid^="subtitle-pg-"]');
  const tracks: Array<{ id: string; label: string; disabled: boolean }> = [];
  for (let i = 0; i < (await items.count()); i++) {
    const item = items.nth(i);
    tracks.push({ id: (await item.getAttribute('data-testid')) ?? '', label: (await item.textContent()) ?? '', disabled: await item.isDisabled() });
  }
  await page.keyboard.press('Escape');
  if (tracks.length === 0) {
    console.log(`${name}: no PG tracks`);
    return;
  }
  const missed: string[] = [];
  for (const track of tracks) {
    if (track.disabled) {
      console.log(`${name}: ${track.id} (${track.label}) not selectable here (UO mask), skipped`);
      continue;
    }
    await page.getByTestId('player').hover();
    await menu.click();
    await page.getByTestId(track.id).click();
    await page.getByTestId('player').hover();
    await menu.click();
    await expect(page.getByTestId(track.id)).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    const seen: string[] = [];
    for (const fraction of SUBTITLE_SEEKS) {
      await page.getByTestId('player').hover();
      const bar = await page.getByTestId('seek').boundingBox();
      if (!bar) throw new Error('seek bar not found');
      await page.mouse.click(bar.x + bar.width * fraction, bar.y + bar.height / 2);
      const targetUs = Number(await page.getByTestId('seek').inputValue()); // where the click put the thumb
      await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
      // only samples taken after the seek landed count (the one in the window may predate it)
      await expect.poll(async () => Math.abs(((await telemetry(page))?.clockUs ?? 0) - targetUs) < 5_000_000, { timeout: 15_000 }).toBe(true);
      const started = Date.now();
      let sets = false;
      let drawn = false;
      while (!drawn && Date.now() - started < SUBTITLE_WAIT_MS) {
        const pg = (await pgTelemetry(page))?.pg;
        sets ||= pg !== null && pg !== undefined;
        drawn = (pg?.objectsShown ?? 0) > 0;
        if (!drawn) await page.waitForTimeout(100);
      }
      const times = scan.streams[Number(track.id.replace('subtitle-pg-', ''))]?.objectTimesUs ?? [];
      const expected = times.some((t) => t >= targetUs && t <= targetUs + SUBTITLE_EXPECTED_US);
      if (expected && !drawn) missed.push(`${track.id} at ${(targetUs / 60e6).toFixed(1)} min`);
      const result = drawn ? `drawn in ${((Date.now() - started) / 1000).toFixed(1)} s` : sets ? 'only empty display sets' : 'nothing';
      seen.push(`${result}${expected ? '' : ' (none due)'}`);
    }
    console.log(`${name}: ${track.id} (${track.label}): ${seen.join(', ')}`);
  }
  const errors = (await pgTelemetry(page))?.pgErrors;
  console.log(`${name}: pgErrors ${errors}`);
  expect(errors, 'PG errors').toBe(0);
  expect(missed, 'subtitles due after a seek but not drawn').toEqual([]);
}
