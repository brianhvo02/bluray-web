import { expect, test, type Page } from '@playwright/test';
import { bdjPlane, clickPlane, goldenSettled, MENU_DISC, planeRegion, regionColour, settlesOn } from './bdj-support';
import { bdjStartup } from './telemetry';

// BD-J menus on every project: chromium, firefox, webkit and mobile-chromium (playwright.config.ts runs this file there
// too; on a touch page clickPlane taps). The plane hashes are the libbluray harness's for the same steps: equal hashes
// prove the plane Java drew (FreeType text through freetype.wasm, the logo, focus changes) matches libbluray's pixel
// for pixel in this browser; a coarse screenshot check proves it reaches the screen.

const notice = (page: Page, text: RegExp) => page.locator('.notice', { hasText: text });

/** Screenshot checks poll this long: under a loaded machine (four browsers in parallel) one screenshot can take seconds. */
const SCREEN_TIMEOUT_MS = 15_000;

async function openMenu(page: Page): Promise<void> {
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  const player = page.getByTestId('player');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true', { timeout: 30_000 });
  await expect(player).toHaveAttribute('data-playlist', '00001'); // the 60 s playlist behind the menu
  await expect(page.getByTestId('playlist-picker')).toBeHidden();
}

/** Chapters' fill (unfocused), left of its text (x 160-679, y 490-589 of the plane): Color(0x20, 0x40, 0x90, 0xc0) over the video. */
const CHAPTERS_FILL = [176, 506, 240, 574] as const;

test('a BD-J menu draws as libbluray draws it, and arrows and Enter drive it', async ({ page }) => {
  const settled = goldenSettled('arrows'); // Play, Chapters, Extras, Chapters, Play focused
  await openMenu(page);
  await settlesOn(page, settled[0]!);
  // the menu reaches the screen: Chapters' translucent fill over the video is not black (and, below, not the video alone).
  // Colours are not compared exactly: screenshots are scaled and colour-managed differently in each browser.
  const region = await planeRegion(page, ...CHAPTERS_FILL);
  // (polled: a screenshot can come before the browser has composited the canvas, and under load takes seconds)
  let shown = { r: 0, g: 0, b: 0 };
  await expect.poll(async () => {
    shown = await regionColour(page, region);
    return shown.r + shown.g + shown.b;
  }, { timeout: SCREEN_TIMEOUT_MS }).toBeGreaterThan(150);

  const player = page.getByTestId('player');
  await page.keyboard.press('ArrowDown');
  await settlesOn(page, settled[1]!);
  // Enter on Chapters does nothing: a second of player time later 00001 still plays under the same menu
  await page.keyboard.press('Enter');
  const entered = (await bdjPlane(page))!;
  await expect.poll(async () => (await bdjPlane(page))!.clockUs, { timeout: 10_000 }).toBeGreaterThan(entered.clockUs + 1_000_000);
  await expect(player).toHaveAttribute('data-playlist', '00001');
  await expect(player).toHaveAttribute('data-bdj-menu', 'true');
  await settlesOn(page, settled[1]!);
  for (const [key, want] of [['ArrowDown', settled[2]], ['ArrowUp', settled[3]], ['ArrowUp', settled[4]]] as const) {
    await page.keyboard.press(key);
    await settlesOn(page, want!);
  }
  await page.keyboard.press('Enter'); // Play: the menu hides and 00000 plays
  await expect(player).toHaveAttribute('data-playlist', '00000', { timeout: 10_000 });
  await expect(player).toHaveAttribute('data-bdj-menu', 'false');
  // without the menu the same region is the video alone
  await expect.poll(async () => {
    const now = await regionColour(page, region);
    return Math.abs(now.r - shown.r) + Math.abs(now.g - shown.g) + Math.abs(now.b - shown.b);
  }, { timeout: SCREEN_TIMEOUT_MS }).toBeGreaterThan(30);
  const startup = await bdjStartup(page);
  console.log(`disc-bdj-menu start-up (${test.info().project.name}): ${JSON.stringify(startup)}`);
});

test("a tap on the menu's MouseListener button reacts; a tap it ignores offers the remote", async ({ page }) => {
  const settled = goldenSettled('mouse'); // shown, Play clicked, then Chapters focused after Down
  await openMenu(page);
  await settlesOn(page, settled[0]!);
  // Play's MouseListener changes its text: the plane libbluray drew for the same click
  await clickPlane(page, 300, 400);
  await settlesOn(page, settled[1]!);
  const clicked = (await bdjPlane(page))!;
  expect(clicked.tapsIgnored).toBe(0); // settled: well past the tap window
  await expect(notice(page, /doesn't respond to taps/)).toHaveCount(0);
  await expect(page.getByTestId('remote-pad')).toBeHidden();
  // empty plane: the disc ignores the tap, so the player says so and opens the remote
  await clickPlane(page, 1400, 540);
  await expect.poll(async () => (await bdjPlane(page))!.tapsIgnored, { timeout: 5_000 }).toBe(1);
  await expect(notice(page, /This disc's menu doesn't respond to taps here\. Use the remote\./)).toBeVisible();
  await expect(page.getByTestId('remote-pad')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await settlesOn(page, settled[2]!);
});

// fixtures/synthetic/disc-bdj-background (scripts/make-bdj-background-disc.ts): BackgroundXlet shows bg.png (64x36, its
// left half #2060c0, its right half #e08020) in the left half of the screen, then plays 4:3 video pillarboxed over it.
// The decode (createImageBitmap on a Blob in the engine worker) and the draw under the video run in the browser.
test("a BD-J background still reaches the screen beside the video it plays under", async ({ page }) => {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < viewport.height) await page.setViewportSize({ width: viewport.height, height: viewport.width }); // phones: landscape, so the 4:3 video leaves the pillarbox to the still
  await page.goto('/?telemetry=1');
  await page.getByTestId('folder-input').setInputFiles('fixtures/synthetic/disc-bdj-background');
  await expect.poll(async () => (await bdjStartup(page))?.firstFrameMs ?? null, { timeout: 30_000 }).not.toBeNull();
  // the left pillarbox: 0-240 of the plane's 1920 is outside the 4:3 picture (240-1680), inside the still (0-960)
  const region = await planeRegion(page, 40, 300, 200, 700);
  await expect.poll(async () => {
    const c = await regionColour(page, region);
    return Math.max(Math.abs(c.r - 0x20), Math.abs(c.g - 0x60), Math.abs(c.b - 0xc0));
  }, { timeout: SCREEN_TIMEOUT_MS }).toBeLessThan(24);
  // the picture itself is the video drawn over the still: not black, and not the still's colour
  const pictureRegion = await planeRegion(page, 600, 300, 900, 700);
  await expect.poll(async () => {
    const c = await regionColour(page, pictureRegion);
    const fromStill = Math.abs(c.r - 0x20) + Math.abs(c.g - 0x60) + Math.abs(c.b - 0xc0);
    return c.r + c.g + c.b > 150 && fromStill > 30;
  }, { timeout: SCREEN_TIMEOUT_MS }).toBe(true);
});

test('a browser that cannot start workers from workers (?nonestedworkers=1) names it and opens the picker', async ({ page }) => {
  await page.goto('/?telemetry=1&nonestedworkers=1');
  await page.getByTestId('folder-input').setInputFiles(MENU_DISC);
  await expect(page.getByTestId('playlist-picker')).toBeVisible({ timeout: 30_000 });
  const missing = /BD-J .*which this browser can't run: it lacks workers started from workers\./;
  await expect(notice(page, missing)).toBeVisible();
  await expect(page.getByTestId('bdj-unsupported')).toHaveText(missing);
  expect(await bdjStartup(page)).toBeNull(); // no BD-J title ran
  await page.getByTestId('playlist-00001').click();
  await expect(page.getByTestId('player')).toHaveAttribute('data-playlist', '00001', { timeout: 15_000 });
});
