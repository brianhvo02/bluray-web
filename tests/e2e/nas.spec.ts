import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CHANGED_FOLDER, NAS_E2E_DIR, NAS_ENV, SERVER, restoreChangedDisc } from './nas-server';
import { skipWithoutH264 } from './support';

// The NAS is tests/e2e/nas-server.ts: the built server over a copy of fixtures/synthetic (root `syn`, whose discs the
// library's top level lists), and the rendezvous Worker that turns a code into the server's address.

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

/** Pairs, then opens the library at its top. */
async function openLibrary(page: Page, browserName: string): Promise<void> {
  await allowLocalNetwork(page, browserName);
  await pairByLink(page);
  await page.getByTestId('nas-open').click();
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
    await mum.getByTestId('nas-open').click();
    await expect(mum.getByTestId('nas-crumbs')).toHaveText('NAS');
    // A guest: the listing is up, and there is no way into the settings.
    await expect(mum.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`)).toBeVisible();
    await expect(mum.getByTestId('nas-settings')).toHaveCount(0);

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
