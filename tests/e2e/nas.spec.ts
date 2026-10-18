import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CHANGED_FOLDER, NAS_E2E_DIR, NAS_ENV, NAS_PORT, OWNER_SERIES, OWNER_STRAY, PROJECTS, SERVER, ownerDiscs, restoreChangedDisc } from './nas-server';
import { normalizeCode } from '../../src/engine/disc/pairing-code';
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

const NAS_API = `http://localhost:${NAS_PORT}/api/`;

const post = async (path: string, body: unknown): Promise<unknown> => {
  const res = await fetch(`${NAS_API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, `POST ${path}`).toBe(200);
  return res.json();
};

let apiSession: Promise<string> | null = null;
/**
 * A session token of an owner device this test worker pairs for itself (`E2E API`), as the app does: redeem an owner
 * code with a new P-256 key, then sign the NAS's challenge. Kept for the worker's run (sessions last an hour).
 */
function apiToken(): Promise<string> {
  apiSession ??= (async () => {
    const code = normalizeCode(ownerCode())!;
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key.publicKey);
    const { deviceId } = (await post('pair/redeem', { code, deviceName: 'E2E API', publicKeyJwk: { kty, crv, x, y } })) as { deviceId: string };
    const { challenge } = (await post('session/challenge', { deviceId })) as { challenge: string };
    const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
    const { token } = (await post('session', { deviceId, challenge, signature })) as { token: string };
    return token;
  })();
  return apiSession;
}

/** An owner route of the NAS API, as the owner device. */
async function ownerApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await apiToken()}`);
  return fetch(`${NAS_API}${path}`, { ...init, headers });
}

/** Sets the release gate as the owner does, through the API. */
async function setGate(gate: 'owners' | 'everyone'): Promise<void> {
  const res = await ownerApi('admin/settings/title-library', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gate }) });
  expect(res.status).toBe(204);
}

/**
 * Waits, through `GET admin/metadata/status`, for the server's first scan and title matching run (it matches after
 * scanning) to have filed the fixture's discs: until then the folder listing is empty, and the app fetches the titles
 * once per session.
 */
async function libraryReady(): Promise<void> {
  await expect
    .poll(
      async () => {
        const status = (await (await ownerApi('admin/metadata/status')).json()) as { running: boolean; lastRunAt: number | null; filed: number };
        return !status.running && status.lastRunAt !== null ? status.filed : 0;
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
        await setGate('everyone');
        await mum.reload();
        await mum.getByTestId('nas-open').click();
        await expect(mum.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
        await expect(mum.locator('[data-testid="title-shelf"][data-shelf="series"]')).toBeVisible();
        await expect(mum.locator('[data-testid="title-shelf"][data-shelf="unsorted"]')).toHaveCount(0);
        await expect(mum.getByTestId('nas-settings')).toHaveCount(0);
        await mum.getByTestId('browse-folders').click();
        await expect(mum.getByTestId('nas-crumbs')).toHaveText('NAS');
      } finally {
        await setGate('owners');
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
  // The shelf counts are the server's: the owner screens' tests change them, and restore them, under the same lock.
  await exclusivelyAsync('catalogue', () => browseByTitle(page, browserName));
});

async function browseByTitle(page: Page, browserName: string): Promise<void> {
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
}

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

test("an episode whose playlist isn't on its disc opens the disc normally, with a notice", async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  // As if the catalogue named a playlist the disc doesn't have.
  await page.route('**/api/titles/anilist%3A900001', async (route) => {
    const res = await route.fetch();
    const detail = (await res.json()) as { seasons: { episodes: { playlistId: string }[] | null }[] };
    for (const s of detail.seasons) for (const e of s.episodes ?? []) e.playlistId = '00009';
    await route.fulfill({ response: res, json: detail });
  });
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('nas-play').click();
  // disc1 has no menu: opened normally, it offers its playlists.
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("This episode isn't on this disc; it opened normally.")).toBeVisible();
  await expect(page.getByTestId('error')).toHaveCount(0);
});

test('the title screens move focus to the new heading, and back to the opener', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  const card = page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]');
  await card.click();
  await expect(page.getByTestId('series-name')).toBeFocused();
  const season = page.locator('[data-testid="season-row"][data-label="Season 1"]');
  await season.click();
  await expect(page.getByTestId('season-screen').locator('h2')).toBeFocused();
  // The tabs: arrow keys move between them, selecting as they go.
  const tabs = page.getByTestId('season-tab');
  await expect(page.getByRole('tablist', { name: 'Season view' })).toBeVisible();
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', (await tabs.nth(1).getAttribute('id'))!);
  await page.getByRole('button', { name: 'Back to Starfall Wanderer' }).click();
  await expect(season).toBeFocused();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(card).toBeFocused();
});

// The owner screens. Each browser files its own discs (nas-server.ts `ownerDiscs`); the tests that change the catalogue
// hold the 'catalogue' lock and put it back as it was, so the browse test's shelf counts hold.

type Project = (typeof PROJECTS)[number];
const projectOf = (name: string): Project => name as Project;
const lastSegment = (folder: string): string => folder.slice(folder.lastIndexOf('/') + 1);
const shelfChip = (page: Page, id: string) => page.locator(`[data-testid="title-shelf"][data-shelf="${id}"]`);
const unsortedCard = (page: Page, folder: string) => page.locator(`[data-testid="unsorted-card"][data-folder="${folder}"]`);

/** Opens the title library, then Unsorted. */
async function openUnsorted(page: Page, browserName: string): Promise<void> {
  await openTitles(page, browserName);
  await shelfChip(page, 'unsorted').click();
  await expect(page.getByTestId('unsorted-screen')).toBeVisible();
}

/** Clears discs' owner choices through the API, as they were before the test. */
async function clearChoices(discIds: readonly (string | null)[]): Promise<void> {
  for (const id of discIds) if (id !== null) await ownerApi(`admin/discs/${encodeURIComponent(id)}/choice`, { method: 'DELETE' });
}

test('Unsorted files a disc under a suggestion, then the other discs of its folder', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = OWNER_SERIES[project];
  const [first, second] = ownerDiscs(project).series.map(lastSegment) as [string, string];
  await exclusivelyAsync('catalogue', async () => {
    const ids: (string | null)[] = [];
    try {
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, first);
      ids.push(await card.getAttribute('data-disc-id'), await unsortedCard(page, second).getAttribute('data-disc-id'));
      await expect(card.getByTestId('unsorted-reason')).toHaveText('Why unsure: No disc number');
      await expect(card).toContainText(`Owner/${project}/${name}`);
      const lookUp = card.getByTestId('unsorted-bluray-com');
      await expect(lookUp).toHaveText('Look up ZMXA-1101 on Blu-ray.com');
      await expect(lookUp).toHaveAttribute('href', 'https://www.blu-ray.com/search/?quicksearch=1&quicksearch_keyword=ZMXA-1101&section=bluraymovies');
      await expect(lookUp).toHaveAttribute('target', '_blank');

      await card.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
      await expect(card.getByTestId('unsorted-season')).toHaveValue('1');
      await card.getByTestId('unsorted-disc').fill('1');
      await card.getByTestId('unsorted-file').click();
      const notice = page.getByTestId('unsorted-notice');
      await expect(notice).toContainText(`Filed under ${name}.`);
      await expect(unsortedCard(page, first)).toHaveCount(0);
      await page.getByTestId('unsorted-apply').filter({ hasText: 'Apply to the other 1 disc in this folder' }).click();
      await expect(notice).toContainText('Filed 1 more disc from this folder.');
      await expect(unsortedCard(page, second)).toHaveCount(0);

      // Back in the library, the series holds both discs.
      await page.getByRole('button', { name: 'Back to the library' }).click();
      await page.locator(`[data-testid="title-card"][data-name="${name}"]`).click();
      await expect(page.getByTestId('series-name')).toHaveText(name);
      await page.getByTestId('season-row').first().click();
      await expect(page.getByTestId('season-screen')).toBeVisible();
      // the Discs tab, when the season has an Episodes tab too
      const discsTab = page.locator('[data-testid="season-tab"][data-tab="discs"]');
      if ((await discsTab.count()) > 0) await discsTab.click();
      await expect(page.getByTestId('disc-card')).toHaveText([/^Disc 1/, /^Disc 2/]);
    } finally {
      await clearChoices(ids);
    }
  });
});

test('"New title…" makes a Music title; "Don\'t list" hides a disc and Unhide brings it back', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  await exclusivelyAsync('catalogue', async () => {
    let stray: string | null = null;
    try {
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, OWNER_STRAY);
      stray = await card.getAttribute('data-disc-id');
      await expect(card.getByTestId('unsorted-reason')).toHaveText('Why unsure: No title found');
      await card.getByRole('button', { name: 'New title…' }).click();
      const form = card.getByTestId('new-title-form');
      await form.getByRole('radio', { name: 'Music' }).check();
      await expect(form.getByTestId('new-title-seasons')).toHaveCount(0);
      await form.getByLabel('Name').fill('Live 2024');
      await form.getByTestId('new-title-create').click();
      await expect(card.getByTestId('new-title-created')).toContainText('Created “Live 2024”. File this disc under it?');
      await card.getByTestId('new-title-later').click();

      await page.getByRole('button', { name: 'Back to the library' }).click();
      await shelfChip(page, 'music').click();
      await expect(page.locator('[data-testid="music-row"][data-name="Live 2024"]')).toContainText('Own title');
      await shelfChip(page, 'music').click();

      // Don't list, then Hidden and Unhide.
      await shelfChip(page, 'unsorted').click();
      await unsortedCard(page, OWNER_STRAY).getByTestId('unsorted-hide').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText('Not listed.');
      await expect(unsortedCard(page, OWNER_STRAY)).toHaveCount(0);
      await page.getByTestId('open-hidden').click();
      const row = page.locator(`[data-testid="hidden-row"][data-folder="${OWNER_STRAY}"]`).filter({ hasText: `Owner/${project}/` });
      await expect(row).toBeVisible();
      await row.getByTestId('hidden-unhide').click();
      await expect(row).toHaveCount(0);
      await page.getByRole('button', { name: 'Back to Unsorted' }).click();
      await expect(unsortedCard(page, OWNER_STRAY).filter({ hasText: `Owner/${project}` })).toBeVisible();
    } finally {
      await clearChoices([stray]);
      const own = (await (await ownerApi(`admin/lookup?q=${encodeURIComponent('Live 2024')}&source=own`)).json()) as { titles: { id: string }[] };
      for (const t of own.titles) await ownerApi(`admin/titles/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    }
  });
});

test('renaming a music title shows the new name on the Music shelf and in search', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  await exclusivelyAsync('catalogue', async () => {
    let stray: string | null = null;
    let musicId: string | null = null;
    try {
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, OWNER_STRAY);
      stray = await card.getAttribute('data-disc-id');
      await card.getByTestId('unsorted-music').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText('Marked as Music.');
      await page.getByRole('button', { name: 'Back to the library' }).click();
      await shelfChip(page, 'music').click();

      const row = page.locator(`[data-testid="music-row"][data-name="${OWNER_STRAY}"]`);
      await expect(row).toContainText(`syn · Owner/${project}/${OWNER_STRAY}`);
      musicId = await row.locator('button[data-title-id]').getAttribute('data-title-id');
      await row.getByRole('button', { name: `Rename ${OWNER_STRAY}` }).click();
      await row.getByLabel('Display name').fill('Reel Session');
      await row.getByTestId('music-save').click();
      const renamed = page.locator('[data-testid="music-row"][data-name="Reel Session"]');
      await expect(renamed).toContainText(`Renamed · was ${OWNER_STRAY}`);

      await page.getByTestId('title-search').fill('reel session');
      await expect(page.getByTestId('title-row')).toHaveCount(1);
      await expect(page.getByTestId('title-row')).toHaveAttribute('data-name', 'Reel Session');
      await page.getByTestId('title-search').fill('');

      // "Use folder name" takes the rename back.
      await renamed.getByRole('button', { name: 'Rename Reel Session' }).click();
      await renamed.getByTestId('music-folder-name').click();
      await expect(row).toBeVisible();
    } finally {
      if (musicId !== null) await ownerApi(`admin/names/${encodeURIComponent(musicId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: null }) });
      await clearChoices([stray]);
    }
  });
});

test('NAS settings show the matching status, the TMDB attribution, and the gate switch asks first', async ({ page, browserName }) => {
  // The switch shows the server's gate, which the guest test opens for a while: the browsers take turns with it.
  await exclusivelyAsync('gate', () => gateSettings(page, browserName));
});

async function gateSettings(page: Page, browserName: string): Promise<void> {
  await openTitles(page, browserName);
  await page.getByTestId('nas-settings').click();
  await expect(page.getByTestId('nas-matching')).toContainText(/Last matched|Matching…/);
  await expect(page.getByTestId('nas-matching')).toContainText(/\d+ discs? filed · \d+ unsorted · \d+ music/);
  await expect(page.getByTestId('nas-tmdb-text')).toHaveText('This product uses the TMDB API but is not endorsed or certified by TMDB');
  const logo = page.getByTestId('nas-tmdb').getByRole('img', { name: 'TMDB' });
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // The answer is stubbed: opening the gate for real would show guests the library in the other browsers' tests.
  const origin = new URL(page.url()).origin;
  const sent: unknown[] = [];
  await page.route('**/api/admin/settings/title-library', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': origin } });
  });
  const gate = page.getByRole('switch', { name: 'Show the title library to everyone' });
  await expect(gate).not.toBeChecked();
  await gate.click();
  await page.getByTestId('nas-gate-cancel').click();
  await expect(gate).not.toBeChecked();
  expect(sent).toEqual([]);
  await gate.click();
  await page.getByTestId('nas-gate-confirm').click();
  await expect(gate).toBeChecked();
  expect(sent).toEqual([{ gate: 'everyone' }]);
}

test('a hidden copy explains what it follows, and "apply to the folder" lists the discs it left', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = OWNER_SERIES[project];
  const [first, second] = ownerDiscs(project).series.map(lastSegment) as [string, string];
  let secondId: string | null = null;
  const cors = (): Record<string, string> => ({ 'Access-Control-Allow-Origin': new URL(page.url()).origin });
  // Stubbed answers: the NAS's own refusals (copies need two discs with one fingerprint) and nothing changed for real.
  await page.route('**/api/admin/discs/*/choice', async (route) => {
    const req = route.request();
    if (req.method() === 'DELETE') return route.fulfill({ status: 409, headers: cors(), json: { error: 'copy-follows-source', source: 'src-disc' } });
    const body = req.postDataJSON() as { applyToGroup?: boolean };
    if (!body.applyToGroup) return route.fulfill({ status: 204, headers: cors() });
    return route.fulfill({ status: 200, headers: cors(), json: { skipped: [{ discId: secondId, reason: 'direct' }] } });
  });
  await page.route('**/api/admin/hidden', (route) =>
    route.fulfill({
      status: 200,
      headers: cors(),
      json: {
        discs: [
          { discId: 'src-disc', root: 'syn', folder: 'Owner/Source Disc', displayName: null },
          { discId: 'copy-disc', root: 'syn', folder: 'Owner/Copy Disc', displayName: null },
        ],
      },
    }),
  );
  await openUnsorted(page, browserName);
  secondId = await unsortedCard(page, second).getAttribute('data-disc-id');
  const card = unsortedCard(page, first);
  await card.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
  await card.getByTestId('unsorted-file').click();
  await page.getByTestId('unsorted-apply').click();
  await expect(page.getByTestId('unsorted-notice')).toContainText('No other disc in this folder was filed.');
  await expect(page.getByTestId('unsorted-skipped')).toHaveText(`${second} (filed separately)`);

  await page.getByTestId('open-hidden').click();
  const copy = page.locator('[data-testid="hidden-row"][data-folder="Copy Disc"]');
  await copy.getByTestId('hidden-unhide').click();
  await expect(copy.getByTestId('hidden-follows')).toContainText('This disc follows its copy at syn/Owner/Source Disc');
  await expect(copy.getByTestId('hidden-own')).toHaveText("Don't list this copy");
  await copy.getByTestId('hidden-file').click();
  await expect(copy.getByTestId('unsorted-card')).toBeVisible();
});
