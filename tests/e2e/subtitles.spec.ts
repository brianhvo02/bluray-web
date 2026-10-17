import { expect, test, type Page } from '@playwright/test';
import { skipWithoutH264 } from './support';

// fixtures/synthetic/disc-subs (scripts/make-subs-disc.ts): a 12 s feature with PG stream 1 (eng: 1–3 s, a forced caption
// 4–6 s, 8–10 s) and stream 2 (jpn: 2–5 s, 7–9 s). First Play turns English on and plays 00000; title 2 plays 00001,
// whose UO mask forbids changing the PG stream.
const DISC = 'fixtures/synthetic/disc-subs';

/** One cue at 6–8 s of playlist time. */
const SAMPLE_SRT = '1\n00:00:06,000 --> 00:00:08,000\nHello from a <i>file</i>\n';
/** The same cue in windows-1252: "Café" is not UTF-8. */
const LATIN1_SRT = Buffer.from(SAMPLE_SRT.replace('Hello from a <i>file</i>', 'Café'), 'latin1');
const MASKED = "The disc doesn't allow this here.";

interface SubtitleTelemetry {
  clockUs: number;
  pg: { objectsShown: number; forced: number } | null;
  pgErrors: number;
  textCue: boolean;
}

async function telemetry(page: Page): Promise<SubtitleTelemetry | null> {
  return page.evaluate(() => (window as unknown as { __blurayTelemetry?: SubtitleTelemetry | null }).__blurayTelemetry ?? null);
}

/** Polls telemetry until a sample taken in [fromUs, toUs) arrives (samples come every 500 ms) and returns it. */
async function sampleBetween(page: Page, fromUs: number, toUs: number): Promise<SubtitleTelemetry> {
  let found: SubtitleTelemetry | null = null;
  await expect
    .poll(async () => {
      const t = await telemetry(page);
      if (t && t.clockUs >= fromUs && t.clockUs < toUs) found = t;
      if (t && t.clockUs >= toUs && !found) throw new Error(`no telemetry sample between ${fromUs} and ${toUs} us (now ${t.clockUs})`);
      return found !== null;
    }, { timeout: 15_000, intervals: [50] })
    .toBe(true);
  return found!;
}

async function openSubsDisc(page: Page): Promise<void> {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await page.getByTestId('folder-input').setInputFiles(DISC);
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
}

async function openMenu(page: Page): Promise<void> {
  await page.getByTestId('player').hover();
  await page.getByTestId('subtitle-menu').click();
}

/** Sets the seek bar as a user would by dragging it, to an exact value (a multiple of its 0.1 s step). */
async function seekTo(page: Page, us: number): Promise<void> {
  await page.getByTestId('seek').evaluate((el, value) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, us);
}

async function pause(page: Page): Promise<void> {
  await page.getByTestId('player').hover();
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'paused');
}

/**
 * While paused, the clock (and telemetry) sits at the seek target. Going through 0 first makes the sample read a fresh one,
 * taken after everything before this call (a repeated value would not seek at all).
 */
async function textCueAt(page: Page, us: number): Promise<boolean> {
  for (const target of [0, us]) {
    await seekTo(page, target);
    await expect.poll(async () => (await telemetry(page))?.clockUs ?? -1, { timeout: 5_000, intervals: [50] }).toBe(target);
  }
  return (await telemetry(page))!.textCue;
}

async function loadThroughMenu(page: Page, name: string, buffer: Buffer): Promise<void> {
  await openMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('subtitle-load').click();
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer });
}

test('shows a picked PG stream at its time', async ({ page }) => {
  await openSubsDisc(page);
  await openMenu(page);
  await expect(page.getByTestId('subtitle-pg-1')).toHaveAttribute('aria-checked', 'true'); // First Play turned English on
  await page.getByTestId('subtitle-pg-1').click();
  await seekTo(page, 0); // from the start, so the 1 s display set is read again
  expect((await sampleBetween(page, 1_200_000, 2_800_000)).pg?.objectsShown).toBeGreaterThan(0);
  expect((await sampleBetween(page, 3_200_000, 3_900_000)).pg?.objectsShown).toBe(0);
  expect((await telemetry(page))!.pgErrors).toBe(0);
});

test('with subtitles off shows the forced caption only', async ({ page }) => {
  await openSubsDisc(page);
  await openMenu(page);
  await page.getByTestId('subtitle-off').click();
  await seekTo(page, 0);
  expect((await sampleBetween(page, 1_200_000, 2_800_000)).pg?.objectsShown ?? 0).toBe(0);
  const forced = await sampleBetween(page, 4_200_000, 5_800_000);
  expect(forced.pg).toEqual({ objectsShown: 1, forced: 1 });
});

test('loads an SRT file from the menu and shifts it with ]', async ({ page }) => {
  await openSubsDisc(page);
  await loadThroughMenu(page, 'sample.srt', Buffer.from(SAMPLE_SRT));
  await openMenu(page);
  await expect(page.getByTestId('subtitle-text')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('subtitle-text')).toHaveText('sample.srt');
  await page.keyboard.press('Escape');
  await pause(page);
  expect(await textCueAt(page, 5_900_000)).toBe(false);
  expect(await textCueAt(page, 6_100_000)).toBe(true);
  for (let i = 0; i < 3; i++) await page.keyboard.press(']');
  await expect(page.getByRole('status').filter({ hasText: 'Subtitles +0.3 s' })).toBeVisible();
  expect(await textCueAt(page, 6_100_000)).toBe(false);
  expect(await textCueAt(page, 6_400_000)).toBe(true);
});

test('loads an SRT file dropped on the player', async ({ page }) => {
  await openSubsDisc(page);
  await page.getByTestId('player').evaluate((el, text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], 'Dropped.SRT', { type: 'text/plain' }));
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, SAMPLE_SRT);
  await openMenu(page);
  await expect(page.getByTestId('subtitle-text')).toHaveText('Dropped.SRT');
  await expect(page.getByTestId('subtitle-text')).toHaveAttribute('aria-checked', 'true');
});

test('asks for the encoding of a file that is not UTF-8', async ({ page }) => {
  await openSubsDisc(page);
  await loadThroughMenu(page, 'latin1.srt', LATIN1_SRT);
  await expect(page.getByTestId('encoding-prompt')).toBeVisible();
  await page.getByTestId('encoding-windows-1252').click();
  await expect(page.getByTestId('encoding-prompt')).toBeHidden();
  await openMenu(page);
  await expect(page.getByTestId('subtitle-text')).toHaveText('latin1.srt');
  await expect(page.getByTestId('subtitle-text')).toHaveAttribute('title', '1 subtitles');
  await page.keyboard.press('Escape');
  await pause(page);
  expect(await textCueAt(page, 6_500_000)).toBe(true);
});

test('refuses a PG stream change the disc masks', async ({ page }) => {
  await openSubsDisc(page);
  await page.getByTestId('player').hover();
  await page.getByTestId('titles').click();
  await page.getByTestId('title-2').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
  await openMenu(page);
  await expect(page.getByTestId('subtitle-pg-1')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('subtitle-pg-2')).toBeDisabled();
  await expect(page.getByTestId('subtitle-pg-2')).toHaveAttribute('title', "The disc doesn't allow this here");
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await expect(page.getByRole('status').filter({ hasText: MASKED })).toBeVisible();
  await openMenu(page);
  await expect(page.getByTestId('subtitle-pg-1')).toHaveAttribute('aria-checked', 'true');
});
