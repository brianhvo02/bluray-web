import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CHANGED_FOLDER, NAS_E2E_DIR, NAS_ENV, NAS_PORT, SERVER, restoreChangedDisc } from './nas-server';
import { skipWithoutH264 } from './support';

// The NAS is tests/e2e/nas-server.ts: the built server over a copy of fixtures/synthetic (root `syn`, whose discs the
// library's top level lists), and the rendezvous Worker that turns a code into the server's address. Its title
// library matches made-up titles from tests/e2e/fixtures/nas-metadata.json against copies of synthetic discs.

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` while no other worker does (the browsers' projects run side by side). */
function exclusively<T>(fn: () => T): T {
  const lock = join(NAS_E2E_DIR, 'owner-code.lock');
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 600) throw err;
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Runs `fn` while no other worker does, holding the lock while `fn` awaits (the release gate is the server's, shared). */
async function exclusivelyAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(NAS_E2E_DIR, `${name}.lock`);
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 1200) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Sets the release gate as the owner does, through the API with the owner device's session token. */
async function setGate(token: string, gate: 'owners' | 'everyone'): Promise<void> {
  const res = await fetch(`http://localhost:${NAS_PORT}/api/admin/settings/title-library`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gate }),
  });
  expect(res.status).toBe(204);
}

/** The last session token `page` sent to the NAS, kept as it goes. */
function watchToken(page: Page): () => string {
  let token: string | null = null;
  page.on('request', (r) => {
    const auth = r.headers()['authorization'];
    if (auth?.startsWith('Bearer ') && r.url().startsWith(`http://localhost:${NAS_PORT}/`)) token = auth.slice(7);
  });
  return () => {
    expect(token).not.toBeNull();
    return token!;
  };
}

/**
 * Waits for the server's first scan and title matching run (it matches after scanning) to have filed the fixture's
 * discs: until then the folder listing is empty, and the app fetches the titles once per session.
 */
async function libraryReady(): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          const meta = JSON.parse(readFileSync(join(NAS_ENV.DATA_DIR!, 'metadata.json'), 'utf8')) as { matches: { status: string }[] };
          return meta.matches.filter((m) => m.status === 'filed').length;
        } catch {
          return 0;
        }
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

/**
 * A fresh owner code, minted the way the NAS owner does: `node server.mjs owner-code` against the server's data.
 * The rendezvous service holds at most 5 live codes per NAS and a run mints about 20 within its 10 minutes, so each
 * code is registered under a new NAS key (the server makes one when its key file is gone).
 */
function ownerCode(): string {
  const out = exclusively(() => {
    rmSync(join(NAS_ENV.DATA_DIR!, 'rendezvous-key.json'), { force: true });
    return execFileSync(process.execPath, [SERVER, 'owner-code'], { env: { ...process.env, ...NAS_ENV }, encoding: 'utf8' });
  });
  expect(out).toContain('Rendezvous: registered');
  return /Owner pairing code: ([0-9A-Z-]+)/.exec(out)![1]!;
}

/** Chrome asks before a page reaches the local network; the tests answer for the user where the browser supports it. */
async function allowLocalNetwork(page: Page, browserName: string): Promise<void> {
  if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
}

async function pairByLink(page: Page): Promise<void> {
  const code = ownerCode();
  await page.goto(`/?pair=${code}&telemetry=1`);
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
}

/** Pairs, then opens the title library (an owner always has it). */
async function openTitles(page: Page, browserName: string): Promise<void> {
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  await pairByLink(page);
  await page.getByTestId('nas-open').click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
}

/** Pairs, then opens the folder browser at its top, from the title library. */
async function openLibrary(page: Page, browserName: string): Promise<void> {
  await openTitles(page, browserName);
  await page.getByTestId('browse-folders').click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS');
}

const discRow = (page: Page, name: string) => page.locator(`[data-testid="nas-disc"][data-name="${name}"]`);

/** Opens a disc's pre-flight and plays it. */
async function playFromNas(page: Page, name: string): Promise<void> {
  await discRow(page, name).click();
  await expect(page.getByTestId('nas-preflight')).toBeVisible();
  await page.getByTestId('nas-play').click();
}

const playerState = (page: Page) => page.getByTestId('player');

test('pairs from a ?pair= link with an owner code', async ({ page, browserName }) => {
  await allowLocalNetwork(page, browserName);
  await pairByLink(page);
  await expect(page.getByTestId('pair-screen')).toBeHidden();
  expect(new URL(page.url()).searchParams.has('pair')).toBe(false);
});

test("pairs with a code typed into the landing screen's field", async ({ page, browserName }) => {
  await allowLocalNetwork(page, browserName);
  const code = ownerCode();
  await page.goto('/');
  await page.getByTestId('pair-code').fill(code.replaceAll('-', '').toLowerCase());
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
});

test("plays disc1 from the NAS after a pre-flight showing this connection's throughput", async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await discRow(page, 'disc1').click();
  await expect(page.getByTestId('nas-preflight-line').first()).toHaveText(/^This connection: \d+ Mbps$/, { timeout: 15_000 });
  await page.getByTestId('nas-play').click();
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('playlist-00000').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
});

test('opens disc-menu from the NAS into its menu', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await playFromNas(page, 'disc-menu');
  await expect(playerState(page)).toHaveAttribute('data-menu-active', 'true', { timeout: 15_000 });
});

test('plays the playlist the Java of disc-bdj selects, from the NAS', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page);
  await playFromNas(page, 'disc-bdj');
  await page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === 'playing', undefined, { polling: 'raf', timeout: 30_000 });
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
});

test('plays disc1.iso from the NAS', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await expect(discRow(page, 'disc1.iso')).toContainText('ISO');
  await playFromNas(page, 'disc1.iso');
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('playlist-00000').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 15_000 });
});

test('a disc deleted after its folder was listed says so', async ({ page, browserName }, testInfo) => {
  const project = testInfo.project.name;
  const dir = restoreChangedDisc(project); // listed by the server's scan at start
  await openLibrary(page, browserName);
  await page.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`).click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText(`NAS › syn › ${CHANGED_FOLDER}`);
  await expect(discRow(page, project)).toBeVisible();
  rmSync(dir, { recursive: true, force: true });
  await discRow(page, project).click();
  await expect(page.getByTestId('nas-error')).toHaveText('This disc changed on the NAS. Open its folder again.');
  await expect(page.getByTestId('nas-play')).toBeDisabled();
});

test('a disc whose probe finds no clip shows no throughput line and still plays', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  // As the server answers for a disc without a .M2TS.
  await page.route('**/discs/*/probe?*', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': new URL(page.url()).origin }, body: '{"error":"not found"}' }),
  );
  await discRow(page, 'disc1').click();
  await expect(page.getByTestId('nas-play')).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByText('Measuring this connection…')).toBeHidden();
  await expect(page.getByTestId('nas-preflight-line')).toHaveCount(0);
  await expect(page.getByTestId('nas-error')).toHaveCount(0);
  await page.getByTestId('nas-play').click();
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
});

test('a disc deleted after its pre-flight fails to open, and Play works again', async ({ page, browserName }, testInfo) => {
  const project = `${testInfo.project.name}-open`;
  const dir = restoreChangedDisc(project);
  await openLibrary(page, browserName);
  await page.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`).click();
  await discRow(page, project).click();
  await expect(page.getByTestId('nas-play')).toBeEnabled({ timeout: 15_000 });
  rmSync(dir, { recursive: true, force: true });
  await page.getByTestId('nas-play').click();
  await expect(page.getByTestId('error')).toContainText('This disc changed on the NAS. Open its folder again.', { timeout: 15_000 });
  await expect(page.getByTestId('nas-play')).toBeEnabled();
});

test('the owner mints a code, pairs a second browser as Mum, revokes it, and rescans', async ({ page, browser, browserName }) => {
  const ownerToken = watchToken(page);
  await openLibrary(page, browserName);
  await page.getByTestId('nas-settings').click();
  await expect(page.getByTestId('nas-admin')).toBeVisible();
  await expect(page.getByTestId('nas-owner-code')).not.toBeChecked();
  await page.getByTestId('nas-new-code').click();
  const codeText = page.getByTestId('nas-code');
  await expect(codeText).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, { timeout: 15_000 });
  await expect(page.getByTestId('nas-code-qr')).toBeVisible();
  await expect(page.getByTestId('nas-code-expiry')).toHaveText(/^Expires in (10:00|9:[0-5]\d)$/);
  await expect(page.getByTestId('nas-code-copy')).toBeVisible();
  const code = (await codeText.textContent())!;

  // A second browser, as the person the owner pairs.
  const mumContext = await browser.newContext();
  try {
    const mum = await mumContext.newPage();
    await allowLocalNetwork(mum, browserName);
    await mum.goto('/');
    await mum.getByTestId('pair-code').fill(code);
    await mum.getByTestId('pair-device-name').fill('Mum');
    const redeemed = mum.waitForResponse((r) => r.url().endsWith('/pair/redeem') && r.request().method() === 'POST');
    await mum.getByTestId('pair-button').click();
    const { deviceId } = (await (await redeemed).json()) as { deviceId: string };
    await expect(mum.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
    // Review Focus 5. The gate is the server's, so the browsers take turns with it.
    await exclusivelyAsync('gate', async () => {
      try {
        // A guest while the gate is closed: the folder browser, with no error notice.
        await mum.getByTestId('nas-open').click();
        await expect(mum.getByTestId('nas-crumbs')).toHaveText('NAS');
        await expect(mum.getByTestId('title-library')).toHaveCount(0);
        await expect(mum.getByTestId('nas-error')).toHaveCount(0);
        await expect(mum.getByTestId('error')).toHaveCount(0);
        // A guest: the listing is up, and there is no way into the settings.
        await expect(mum.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`)).toBeVisible();
        await expect(mum.getByTestId('nas-settings')).toHaveCount(0);

        // Once the owner opens the gate, the guest's next app load shows the library, without the owner's parts.
        await setGate(ownerToken(), 'everyone');
        await mum.reload();
        await mum.getByTestId('nas-open').click();
        await expect(mum.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
        await expect(mum.locator('[data-testid="title-shelf"][data-shelf="series"]')).toBeVisible();
        await expect(mum.locator('[data-testid="title-shelf"][data-shelf="unsorted"]')).toHaveCount(0);
        await expect(mum.getByTestId('nas-settings')).toHaveCount(0);
        await mum.getByTestId('browse-folders').click();
        await expect(mum.getByTestId('nas-crumbs')).toHaveText('NAS');
      } finally {
        await setGate(ownerToken(), 'owners');
      }
    });

    // The owner sees both devices: this one and Mum (other tests' devices share the server).
    const mumRow = page.locator(`[data-testid="nas-device"][data-device-id="${deviceId}"]`);
    await expect(mumRow).toContainText(/^Mum · paired .+ · last seen just now/, { timeout: 15_000 });
    const ownRow = page.getByTestId('nas-device').filter({ hasText: '(this device)' });
    await expect(ownRow).toHaveCount(1);
    // This device's own row asks first.
    await ownRow.getByTestId('nas-revoke').click();
    await expect(ownRow).toContainText('Revoke this device?');
    await ownRow.getByTestId('nas-revoke-cancel').click();
    await expect(ownRow.getByTestId('nas-revoke')).toBeVisible();
    await mumRow.getByTestId('nas-revoke').click();
    await expect(mumRow).toHaveCount(0);

    // Mum's next library request finds the device revoked: back to the landing screen.
    await mum.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`).click();
    await expect(mum.getByTestId('error')).toHaveText('This device is no longer paired with the NAS.');
    await expect(mum.getByTestId('pair-screen')).toBeVisible();
    await expect(mum.getByTestId('nas-library')).toHaveCount(0);
  } finally {
    await mumContext.close();
  }

  await page.getByTestId('nas-rescan').click();
  await expect(page.getByTestId('nas-admin-status')).toHaveText('Rescanning…');

  // Ticking Owner mints an owner code. The answer is stubbed: a second code per browser registered with the
  // rendezvous service would pass its 5-live-codes cap on this server's key (redeeming one is tested in server/).
  await page.getByTestId('nas-owner-code').check();
  const origin = new URL(page.url()).origin;
  let minted: unknown;
  await page.route('**/api/admin/codes', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    minted = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': origin },
      body: JSON.stringify({ code: 'K7QM-4XP2-R9TD', link: 'https://bluray-web.pages.dev/?pair=K7QM4XP2R9TD', expiresAt: Date.now() + 600_000, rendezvous: false }),
    });
  });
  await page.getByTestId('nas-new-code').click();
  await expect(codeText).toHaveText('K7QM-4XP2-R9TD');
  expect(minted).toEqual({ owner: true });
});

test('an owner browses the NAS by title: shelves, search, a series and its season', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  const shelf = (id: string) => page.locator(`[data-testid="title-shelf"][data-shelf="${id}"]`);
  await expect(shelf('series')).toHaveText(/^Series\s*1$/);
  await expect(shelf('movie')).toHaveText(/^Movies\s*1$/);
  await expect(shelf('music')).toHaveText(/^Music\s*1$/);
  await expect(shelf('unsorted')).toContainText('Unsorted');
  const card = (name: string) => page.locator(`[data-testid="title-card"][data-name="${name}"]`);
  await expect(card('Starfall Wanderer')).toContainText('星降りの旅人');
  await expect(card('Moonlit Harbor')).toBeVisible();
  await expect(card('Lantern Parade Live 2024')).toBeVisible();

  // Search by English, romaji and Japanese names; a blank search shows the shelves again.
  const search = page.getByTestId('title-search');
  const results = page.getByTestId('title-row');
  for (const [query, name] of [['starfall', 'Starfall Wanderer'], ['hoshifuri', 'Starfall Wanderer'], ['月影', 'Moonlit Harbor']]) {
    await search.fill(query!);
    await expect(results).toHaveCount(1);
    await expect(results).toHaveAttribute('data-name', name!);
  }
  await search.fill('');
  await expect(card('Moonlit Harbor')).toBeVisible();

  // The Movies shelf alone.
  await shelf('movie').click();
  await expect(page.getByTestId('title-card')).toHaveCount(1);
  await expect(card('Moonlit Harbor')).toBeVisible();
  await shelf('movie').click();

  // The series, its season, and the season's Episodes and Discs.
  await card('Starfall Wanderer').click();
  await expect(page.getByTestId('series-name')).toHaveText('Starfall Wanderer');
  await expect(page.getByTestId('series-screen')).toContainText('Hoshifuri no Tabibito');
  await expect(page.getByTestId('series-screen')).toContainText('TV · 2016 · 1 season');
  const season = page.locator('[data-testid="season-row"][data-label="Season 1"]');
  await expect(season).toContainText('1 episode · 2 discs');
  await season.click();
  await expect(page.getByTestId('season-screen')).toContainText('Starfall Wanderer');
  await expect(page.getByTestId('season-tab')).toHaveText(['Episodes', 'Discs']);
  await expect(page.getByTestId('episode-row')).toHaveCount(1);
  await expect(page.getByTestId('episode-row')).toContainText('Episode 1');
  await page.locator('[data-testid="season-tab"][data-tab="discs"]').click();
  await expect(page.getByTestId('disc-card')).toHaveText([/^Disc 1 · Episode 1/, /^Disc 2/]);
  await expect(page.getByTestId('disc-copy').first()).toContainText('Anime/Starfall Wanderer (星降りの旅人)/Starfall Wanderer Vol.1');
});

test("tapping an episode plays the episode's playlist", async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await expect(page.getByTestId('nas-preflight')).toContainText('Episode 1 · Starfall Wanderer Vol.1');
  await page.getByTestId('nas-play').click();
  // The episode is disc1's 4-second playlist 00001, not the 00000 the disc's picker would offer first.
  await page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === 'playing', undefined, { polling: 'raf', timeout: 15_000 });
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00001');
});

test('"Browse by folder instead" opens the folder browser', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await page.getByTestId('browse-folders').click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS');
  await expect(page.getByTestId('title-library')).toHaveCount(0);
  await expect(page.locator('[data-testid="nas-folder"][data-name="Anime"]')).toBeVisible();
});
