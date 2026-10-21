import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';
import { CHANGED_FOLDER, NAS_E2E_DIR, NAS_ENV, NAS_PORT, NAS_SERVER_KEY, OWNER_SERIES, PROJECTS, RENDEZVOUS_URL, SERVER, ownerDiscs, ownerStray, restoreChangedDisc } from './nas-server';
import { discKeyOf } from '../../src/engine/disc/disc-key';
import { normalizeCode } from '../../src/engine/disc/pairing-code';
import { skipWithoutH264 } from './support';
import { telemetry } from './telemetry';

// The NAS is tests/e2e/nas-server.ts: the built server over a copy of fixtures/synthetic (root `syn`, whose discs the
// library's top level lists), and the rendezvous Worker that turns a code into the server's address. Its title
// library matches made-up titles from tests/e2e/fixtures/nas-metadata.json against copies of synthetic discs.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

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
  return mintOwnerCode(() => rmSync(join(NAS_ENV.DATA_DIR!, 'rendezvous-key.json'), { force: true }));
}

/**
 * A fresh owner code whose WebRTC route leads to the running server: minted under the server's own rendezvous key
 * (its NAS id, whose signalling socket is open), put back in place of the last code's.
 */
function serverOwnerCode(): string {
  return mintOwnerCode(() => copyFileSync(NAS_SERVER_KEY, join(NAS_ENV.DATA_DIR!, 'rendezvous-key.json')));
}

function mintOwnerCode(prepareKey: () => void): string {
  const out = exclusively(() => {
    prepareKey();
    return execFileSync(process.execPath, [SERVER, 'owner-code'], { env: { ...process.env, ...NAS_ENV }, encoding: 'utf8' });
  });
  expect(out).toContain('Rendezvous: registered');
  return /Owner pairing code: ([0-9A-Z-]+)/.exec(out)![1]!;
}

/**
 * Counts the bytes the page's WebRTC data channels receive (`window.__rtcBytes`), in every page load: the positive proof
 * that the disc's reads came over the channel.
 */
async function countChannelBytes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __rtcBytes: number };
    w.__rtcBytes = 0;
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, ...args: Parameters<typeof create>) {
      const channel = create.apply(this, args);
      channel.addEventListener('message', (e: MessageEvent<unknown>) => {
        const data = e.data;
        w.__rtcBytes += data instanceof ArrayBuffer ? data.byteLength : data instanceof Blob ? data.size : String(data).length;
      });
      return channel;
    };
  });
}

const channelBytes = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __rtcBytes: number }).__rtcBytes);

/** The rendezvous lookup as for a NAS whose HTTPS route this network can't use: its WebRTC route only. */
async function webrtcOnlyLookup(page: Page): Promise<void> {
  await page.route(`${RENDEZVOUS_URL}/codes/lookup`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { routes?: { webrtc?: unknown } };
    expect(body.routes?.webrtc).toBeDefined();
    await route.fulfill({ response, json: { ...body, routes: { webrtc: body.routes?.webrtc } } });
  });
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

test('buffers first on a slow connection: the pre-flight asks, and Wait fills the cache, then the disc plays', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the pre-flight flow; the cache is unit-tested');
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  // ?bufferask=1: disc1 plays for 8 s, so its wait is seconds long; the flag makes the pre-flight ask before any wait.
  const code = ownerCode();
  await page.goto(`/?pair=${code}&telemetry=1&bufferask=1`);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
  await skipWithoutH264(page, { realtime: false });
  // The probe throttled to about 1 Mbps (125 kB in a second), below disc1's rate (about 2.9 Mbps with the margin).
  await page.route('**/discs/*/probe?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'Access-Control-Allow-Origin': new URL(page.url()).origin }, body: Buffer.alloc(125_000) });
  });
  await page.getByTestId('nas-open').click();
  await page.getByTestId('browse-folders').click();
  await discRow(page, 'disc1').click();
  await expect(page.getByTestId('nas-buffer-wait')).toHaveText('About 1 minutes before it can play straight through', { timeout: 15_000 });
  await expect(page.getByTestId('nas-play')).toHaveText('Play now with pauses');
  await expect(page.getByRole('button', { name: 'Lower quality (coming later)' })).toBeDisabled();
  await page.getByTestId('nas-wait').click();
  // disc1 opens to its playlists once the cache holds the wait's bytes
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  const cached = await page.evaluate(async () => {
    const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('read-ahead');
    const names: string[] = [];
    for await (const disc of (top as unknown as { values(): AsyncIterable<FileSystemDirectoryHandle> }).values()) {
      for await (const name of (disc as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    }
    return names;
  });
  expect(cached.some((name) => name.startsWith('BDMV_2fSTREAM_2f00001_2eM2TS.') && name.endsWith('.bin'))).toBe(true);
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

test('pairs, browses and plays over WebRTC when HTTPS to the NAS is unreachable: disc1 for 3 s, then disc-bdj', async ({ page, browserName }) => {
  // Measured 2026-10-19 in Playwright's Firefox on Linux (CI and the Playwright image): the peer connection gathers no
  // ICE candidates at all, whatever the media.peerconnection.ice.* prefs, and fails before the answer arrives.
  // Firefox on macOS runs this test, and the device run covers real browsers.
  test.skip(browserName === 'firefox' && process.platform === 'linux', 'Playwright Firefox on Linux gathers no ICE candidates');
  test.setTimeout(180_000);
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  const httpsTried: string[] = [];
  await page.context().route(`http://localhost:${NAS_PORT}/**`, (route) => {
    httpsTried.push(route.request().url());
    return route.abort('connectionrefused');
  });
  await webrtcOnlyLookup(page);
  await countChannelBytes(page);
  const code = serverOwnerCode();
  await page.goto(`/?pair=${code}&telemetry=1&rtcrelayed=1`);
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('nas-paired')).toBeVisible({ timeout: 30_000 });
  await skipWithoutH264(page);
  const browse = async (): Promise<void> => {
    await page.getByTestId('nas-open').click();
    await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('browse-folders').click();
    await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS');
  };
  await browse();
  await playFromNas(page, 'disc1');
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('playlist-00000').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'playing', { timeout: 20_000 });
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(3_000_000);
  await expect(page.getByTestId('relay-badge')).toContainText('Relayed'); // ?rtcrelayed=1 makes the connection count as relayed
  expect(await channelBytes(page)).toBeGreaterThan(1_000_000); // most of disc1's first 1.3 MB clip, over the channel

  // A new page load: the pairing has no HTTPS base, so it connects over WebRTC at once. The address bar kept the play
  // link, so the load opens the disc's pre-flight (resolved over the channel); its Back returns to the folder browser.
  await page.reload();
  await expect(page.getByTestId('nas-preflight')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nas-preflight').getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS', { timeout: 30_000 });
  await playFromNas(page, 'disc-bdj');
  await page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === 'playing', undefined, { polling: 'raf', timeout: 45_000 });
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
  await expect.poll(() => channelBytes(page)).toBeGreaterThan(500_000); // disc-bdj's 0.66 MB clip, over the channel
  expect(httpsTried).toEqual([]);
});

test("a device that connects while the NAS's signalling socket is down is told it can't connect", async ({ page, browserName }) => {
  await allowLocalNetwork(page, browserName);
  await webrtcOnlyLookup(page);
  const code = ownerCode(); // under a NAS key of its own, whose signalling socket never opens
  const closed: string[] = [];
  page.on('websocket', (ws) => ws.on('close', () => closed.push(new URL(ws.url()).pathname)));
  await page.goto(`/?pair=${code}`);
  await expect(page.getByTestId('pair-code')).toHaveValue(code);
  const started = Date.now();
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('pair-error')).toHaveText("Can't connect to the NAS from this network. Try another Wi-Fi or mobile data.", { timeout: 15_000 });
  // The Worker's offline close (4404), not the 10 s wait for its hello.
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(closed).toContain('/signal/device');
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

test('the owner invites Mika, who pairs as Mika, then removes Mika, and rescans', async ({ page, browser, browserName }) => {
  await openLibrary(page, browserName);
  await page.getByTestId('nas-settings').click();
  await expect(page.getByTestId('nas-admin')).toBeVisible();
  // A code for a new person, Mika, not an owner, sent as an invite.
  await expect(page.getByTestId('nas-code-person')).toHaveValue('new');
  await page.getByTestId('nas-new-person-name').fill('Mika');
  await expect(page.getByTestId('nas-new-person-owner')).not.toBeChecked();
  await page.getByTestId('nas-code-invite').check();
  const mintedResponse = page.waitForResponse((r) => r.url().endsWith('/admin/codes') && r.request().method() === 'POST');
  await page.getByTestId('nas-new-code').click();
  const minted = (await (await mintedResponse).json()) as { personId: string; personName: string; invite: boolean };
  expect(minted).toMatchObject({ personName: 'Mika', invite: true });
  const codeText = page.getByTestId('nas-code');
  await expect(codeText).toHaveText(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, { timeout: 15_000 });
  await expect(page.getByTestId('nas-code-qr')).toBeVisible();
  await expect(page.getByTestId('nas-code-for')).toHaveText('For Mika · an invite, valid 3 days');
  await expect(page.getByTestId('nas-code-expiry')).toHaveText('Expires in 3 days');
  await expect(page.getByTestId('nas-code-copy')).toBeVisible();
  const code = (await codeText.textContent())!;
  // Every browser's project makes its own Mika on the shared server: this one is found by its id.
  const mikaRow = page.locator(`[data-testid="nas-person-Mika"][data-person-id="${minted.personId}"]`);
  await expect(mikaRow).toContainText('No devices yet');

  // A second browser, as Mika.
  const mikaContext = await browser.newContext();
  try {
    const mika = await mikaContext.newPage();
    await allowLocalNetwork(mika, browserName);
    await mika.goto('/');
    await mika.getByTestId('pair-code').fill(code);
    await mika.getByTestId('pair-device-name').fill('iPad');
    await mika.getByTestId('pair-button').click();
    await expect(mika.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
    await expect(mika.getByTestId('nas-paired')).toContainText('Paired as Mika.');
    // Review Focus 5. The gate is the server's, so the browsers take turns with it.
    await exclusivelyAsync('gate', async () => {
      try {
        // A guest while the gate is closed: the folder browser, with no error notice.
        await mika.getByTestId('nas-open').click();
        await expect(mika.getByTestId('nas-crumbs')).toHaveText('NAS');
        await expect(mika.getByTestId('title-library')).toHaveCount(0);
        await expect(mika.getByTestId('nas-error')).toHaveCount(0);
        await expect(mika.getByTestId('error')).toHaveCount(0);
        // A guest: the listing is up, and there is no way into the settings.
        await expect(mika.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`)).toBeVisible();
        await expect(mika.getByTestId('nas-settings')).toHaveCount(0);
        // The guest's folders are in the address bar too: a folder, then the browser's Back, is the top again.
        expect(new URL(mika.url()).pathname).toBe('/nas/folders');
        await mika.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`).click();
        await expect(mika.getByTestId('nas-crumbs')).not.toHaveText('NAS');
        await mika.goBack();
        await expect(mika.getByTestId('nas-crumbs')).toHaveText('NAS');
        await expect(mika.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`)).toBeVisible();

        // Once the owner opens the gate, the guest's next app load shows the library, without the owner's parts.
        await setGate('everyone');
        await mika.goto('/');
        await mika.getByTestId('nas-open').click();
        await expect(mika.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
        await expect(mika.locator('[data-testid="title-shelf"][data-shelf="series"]')).toBeVisible();
        await expect(mika.locator('[data-testid="title-shelf"][data-shelf="unsorted"]')).toHaveCount(0);
        await expect(mika.getByTestId('nas-settings')).toHaveCount(0);
        await mika.getByTestId('browse-folders').click();
        await expect(mika.getByTestId('nas-crumbs')).toHaveText('NAS');
      } finally {
        await setGate('owners');
      }
    });

    // The owner's People list shows Mika with one device (other tests' people and devices share the server).
    await expect(mikaRow.getByTestId('nas-device')).toHaveCount(1, { timeout: 15_000 });
    await expect(mikaRow.getByTestId('nas-device')).toContainText(/^iPad · last seen just now/);
    await expect(mikaRow.locator('.badge')).toHaveCount(0);
    const ownRow = page.getByTestId('nas-device').filter({ hasText: '(this device)' });
    await expect(ownRow).toHaveCount(1);
    // This device's own row asks first.
    await ownRow.getByTestId('nas-revoke').click();
    await expect(ownRow).toContainText('Revoke this device?');
    await ownRow.getByTestId('nas-revoke-cancel').click();
    await expect(ownRow.getByTestId('nas-revoke')).toBeVisible();
    // So does taking owner rights from this device's own person.
    const ownPersonRow = page.locator('[data-person-id]').filter({ has: ownRow });
    await ownPersonRow.getByTestId('nas-person-owner').click();
    await expect(ownPersonRow).toContainText('This device will lose NAS settings. Only another owner can give them back.');
    await ownPersonRow.getByRole('button', { name: 'Cancel' }).click();
    await expect(ownPersonRow.getByTestId('nas-person-owner')).toHaveText('Remove owner');
    // Removing Mika says what goes first.
    await mikaRow.getByTestId('nas-person-remove').click();
    await expect(mikaRow).toContainText('Remove Mika? Their device iPad is unpaired.');
    await mikaRow.getByTestId('nas-person-remove-confirm').click();
    await expect(mikaRow).toHaveCount(0);

    // Mika's next library request finds the device gone with its person: back to pairing.
    await mika.locator(`[data-testid="nas-folder"][data-name="${CHANGED_FOLDER}"]`).click();
    await expect(mika.getByTestId('error')).toHaveText('This device is no longer paired with the NAS.');
    await expect(mika.getByTestId('pair-screen')).toBeVisible();
    await expect(mika.getByTestId('nas-library')).toHaveCount(0);
  } finally {
    await mikaContext.close();
  }

  await page.getByTestId('nas-rescan').click();
  await expect(page.getByTestId('nas-admin-status')).toHaveText('Rescanning…');

  // A plain code for an existing person: this device's. The answer is stubbed: another code per browser registered
  // with the rendezvous service would pass its 20-live-codes cap on this server's key (redeeming one is tested in server/).
  const ownPerson = page.locator('[data-person-id]').filter({ has: page.getByTestId('nas-device').filter({ hasText: '(this device)' }) });
  const ownPersonId = (await ownPerson.getAttribute('data-person-id'))!;
  await expect(page.getByTestId('nas-code-person')).toHaveValue('new');
  await page.getByTestId('nas-code-person').selectOption(ownPersonId);
  await expect(page.getByTestId('nas-new-person-name')).toHaveCount(0);
  await page.getByTestId('nas-code-invite').uncheck();
  const origin = new URL(page.url()).origin;
  let body: unknown;
  await page.route('**/api/admin/codes', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': origin },
      body: JSON.stringify({
        code: 'K7QM-4XP2-R9TD', link: 'https://bluray-web.pages.dev/?pair=K7QM4XP2R9TD', expiresAt: Date.now() + 600_000, rendezvous: false,
        personId: ownPersonId, personName: 'Owner', invite: false,
      }),
    });
  });
  await page.getByTestId('nas-new-code').click();
  await expect(codeText).toHaveText('K7QM-4XP2-R9TD');
  await expect(page.getByTestId('nas-code-for')).toHaveText('For Owner · valid 10 minutes');
  expect(body).toEqual({ personId: ownPersonId, invite: false });
  // The stub's code wasn't registered with the rendezvous service: it says where the code still works.
  await expect(page.getByTestId('nas-code-rendezvous')).toHaveText(
    "The pairing service didn't take this code, so it only works on your home network or over Tailscale. Try again later for a friend away from home.",
  );

  // Another owner takes this device's owner status away (stubbed, as the Owner person is every browser's): the next
  // people reload is refused, the settings close, and the library no longer offers them.
  const stub = (status: number, json: unknown) => (route: Route) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: JSON.stringify(json) });
  await page.route('**/api/admin/people', stub(403, { error: 'forbidden' }));
  await page.route('**/api/me', stub(200, { owner: false, titleLibrary: false, personId: ownPersonId, personName: 'Owner' }));
  await page.getByTestId('nas-new-code').click();
  await expect(page.getByTestId('nas-admin')).toHaveCount(0);
  await expect(page.getByTestId('nas-admin-error')).toHaveCount(0);
  await expect(page.getByTestId('nas-crumbs')).toBeVisible();
  await expect(page.getByTestId('nas-settings')).toHaveCount(0);
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

/** The page's path and query, without the origin. */
const pathOf = (page: Page): string => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

test('library screens are in the address bar, and Back and Forward move between them', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  expect(pathOf(page)).toBe('/nas');
  const card = page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]');
  const titleId = (await card.getAttribute('data-title-id'))!;
  await card.click();
  await expect(page.getByTestId('series-name')).toHaveText('Starfall Wanderer');
  expect(pathOf(page)).toBe(`/nas/title/${encodeURIComponent(titleId)}`);
  const season = page.locator('[data-testid="season-row"][data-label="Season 1"]');
  // The season's key in the path is its catalogue id after the '#'.
  const seasonId = (await season.getAttribute('data-season-id'))!;
  const seasonPath = `/nas/title/${encodeURIComponent(titleId)}/season/${encodeURIComponent(seasonId.slice(seasonId.indexOf('#') + 1))}`;
  await season.click();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  expect(pathOf(page)).toBe(seasonPath);

  await page.goBack();
  await expect(page.getByTestId('series-screen')).toBeVisible();
  await expect(page.getByTestId('season-screen')).toHaveCount(0);
  await expect(season).toBeFocused();
  await page.goForward();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  expect(pathOf(page)).toBe(seasonPath);

  await page.goBack();
  await page.goBack();
  await expect(card).toBeFocused();
  expect(pathOf(page)).toBe('/nas');
  await page.locator('[data-testid="title-shelf"][data-shelf="movie"]').click();
  await expect(page.getByTestId('title-card')).toHaveCount(1);
  expect(pathOf(page)).toBe('/nas?shelf=movie');

  // A search reaches the address bar once typing pauses, and a reload shows it.
  await page.getByTestId('title-search').fill('moonlit');
  await expect.poll(() => pathOf(page)).toBe('/nas?shelf=movie&q=moonlit');
  await page.reload();
  await expect(page.getByTestId('title-search')).toHaveValue('moonlit', { timeout: 15_000 });
  await expect(page.getByTestId('title-row')).toHaveAttribute('data-name', 'Moonlit Harbor');

  // Back within the typing delay: the pending search write must not overwrite the entry Back landed on.
  await page.getByTestId('title-search').fill('zzz');
  await page.goBack();
  await expect.poll(() => pathOf(page)).toBe('/nas');
  await page.waitForTimeout(1000);
  expect(pathOf(page)).toBe('/nas');
});

test('a library path opens straight onto its screen after a reload', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  const seasonPath = pathOf(page);
  // Notes whether the library's own screen (its search field) ever shows during the reload.
  await page.addInitScript(() => {
    const w = window as unknown as { __librarySeen: boolean };
    w.__librarySeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="title-search"]')) w.__librarySeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(page.getByTestId('season-screen').locator('h2')).toHaveText('Season 1', { timeout: 15_000 });
  expect(pathOf(page)).toBe(seasonPath);
  expect(await page.evaluate(() => (window as unknown as { __librarySeen: boolean }).__librarySeen)).toBe(false);
  // In-app Back from a screen opened by a reload (no app entry behind it) goes to its parent in place.
  await page.getByRole('button', { name: 'Back to Starfall Wanderer' }).click();
  await expect(page.getByTestId('series-screen')).toBeVisible();
  expect(pathOf(page)).toBe(seasonPath.slice(0, seasonPath.lastIndexOf('/season/')));
});

test('the folder browser has its folder in the address bar', async ({ page, browserName }) => {
  await openLibrary(page, browserName);
  expect(pathOf(page)).toBe('/nas/folders');
  await page.locator('[data-testid="nas-folder"][data-name="Anime"]').click();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS › syn › Anime');
  expect(pathOf(page)).toBe('/nas/folders/syn/Anime');
  await expect(page.locator('[data-testid="nas-folder"][data-name^="Starfall Wanderer"]')).toBeVisible();
  const folders = await page.getByTestId('nas-folder').allTextContents();
  await page.reload();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS › syn › Anime', { timeout: 15_000 });
  await expect(page.getByTestId('nas-folder')).toHaveText(folders);
  await page.goBack();
  await expect(page.getByTestId('nas-crumbs')).toHaveText('NAS');
  expect(pathOf(page)).toBe('/nas/folders');
});

test('a device unpaired while on a NAS path goes back to the landing page', async ({ page, browserName }) => {
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  const redeemed = page.waitForResponse((r) => r.url().endsWith('/api/pair/redeem') && r.request().method() === 'POST');
  await pairByLink(page);
  const { deviceId } = (await (await redeemed).json()) as { deviceId: string };
  await page.getByTestId('nas-open').click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
  expect(pathOf(page)).toBe('/nas');

  // The library's own requests are answered before the device is revoked, so the click is what finds it revoked.
  const card = page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]');
  await expect(card).toBeVisible();
  const res = await ownerApi(`admin/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  expect(res.status).toBe(204);
  await card.click();
  await expect(page.getByTestId('error')).toHaveText('This device is no longer paired with the NAS.');
  await expect(page.getByTestId('pair-screen')).toBeVisible();
  expect(pathOf(page)).toBe('/');
  await page.reload();
  await expect(page.getByTestId('pair-screen')).toBeVisible({ timeout: 15_000 });
  expect(pathOf(page)).toBe('/');
  await expect(page.getByTestId('title-library')).toHaveCount(0);
});

/** The `f.` link key of disc1 (and its copies), as the app works it out from a manifest (whose paths are upper-case). */
function disc1Key(): string {
  return syntheticDiscKey('disc1');
}

/** The `f.` link key of a synthetic disc, worked out as `disc1Key` is. */
function syntheticDiscKey(name: string): string {
  const dir = join(REPO_ROOT, 'fixtures/synthetic', name, 'BDMV/STREAM');
  const files = readdirSync(dir).map((name) => ({ path: `BDMV/STREAM/${name.toUpperCase()}`, size: statSync(join(dir, name)).size }));
  const key = discKeyOf('0000000000000000', files);
  expect(key).toMatch(/^f\.[0-9A-F]{32}$/);
  return key;
}

/** The name of the disc a key opens (the copy the NAS picks). */
async function resolvedName(key: string): Promise<string> {
  const res = await ownerApi(`discs/resolve/${encodeURIComponent(key)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { disc: { name: string } }).disc.name;
}

const waitForPlaying = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === 'playing', undefined, { polling: 'raf', timeout: 15_000 });

/** The address bar's play route: its path, playlist and time. */
const playLinkOf = (page: Page): { path: string; pl: string | null; t: number | null } => {
  const url = new URL(page.url());
  const t = url.searchParams.get('t');
  return { path: url.pathname, pl: url.searchParams.get('pl'), t: t === null ? null : Number(t) };
};

test('playing a NAS episode keeps a play link in the address bar', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page);
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  // The episode is 4 s long (the fixture's), so the time is checked on a pause, which writes it at once.
  await expect.poll(() => playLinkOf(page).pl).toBe('00001');
  expect(playLinkOf(page).path).toMatch(/^\/nas\/play\/f\.[0-9A-F]{32}$/);
  expect(playLinkOf(page).path).toBe(`/nas/play/${disc1Key()}`);
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2_000_000);
  await page.getByTestId('video-canvas').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'paused');
  await expect.poll(() => playLinkOf(page).t ?? -1).toBeGreaterThanOrEqual(2);
  expect(playLinkOf(page).pl).toBe('00001');
});

test('a play link opens the pre-flight, then plays from its time', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page);
  const key = disc1Key();
  await page.goto(`/nas/play/${key}?pl=00000&t=5&telemetry=1`);
  await expect(page.getByTestId('nas-preflight').locator('h3')).toHaveText(await resolvedName(key), { timeout: 15_000 });
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
  // 5 s into the 8 s playlist within 2 s of playing: only the link's seek gets there that soon.
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 2_000, intervals: [100] }).toBeGreaterThanOrEqual(5_000_000);
  // The link's time stays in the address bar while the playlist starts, then the seek writes it.
  expect(playLinkOf(page).t).toBeGreaterThanOrEqual(5);

  // Paused a little later, the address bar has the time; a reload lands on the pre-flight with it, not on playback.
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5_000 }).toBeGreaterThanOrEqual(6_000_000);
  await page.getByTestId('video-canvas').click();
  await expect(playerState(page)).toHaveAttribute('data-state', 'paused');
  await expect.poll(() => playLinkOf(page).t ?? -1).toBeGreaterThanOrEqual(6);
  const last = playLinkOf(page);
  expect(last).toMatchObject({ path: `/nas/play/${key}`, pl: '00000' });
  await page.reload();
  await expect(page.getByTestId('nas-preflight')).toBeVisible({ timeout: 15_000 });
  await expect(playerState(page)).toHaveCount(0);
  expect(playLinkOf(page)).toEqual(last);
});

test('Back during NAS playback closes the disc and returns to the season', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  const seasonPath = pathOf(page);
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  await page.goBack();
  await expect(page.getByTestId('season-screen')).toBeVisible({ timeout: 15_000 });
  await expect(playerState(page)).toHaveCount(0);
  expect(pathOf(page)).toBe(seasonPath);

  // A link opened cold has no app entry behind it: the player's close lands on the library, still in the app.
  await page.goto(`/nas/play/${disc1Key()}?pl=00000`);
  await page.getByTestId('nas-play').click({ timeout: 15_000 });
  await waitForPlaying(page);
  await page.getByRole('button', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: 'Open another disc' }).click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
  await expect(playerState(page)).toHaveCount(0);
  expect(pathOf(page)).toBe('/nas');
});

test("Back while a play link's disc opens closes it, and the screen Back went to stays", async ({ page, context, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page, { realtime: false });
  await page.locator('[data-testid="title-card"][data-name="Starfall Wanderer"]').click();
  await page.locator('[data-testid="season-row"][data-label="Season 1"]').click();
  await expect(page.getByTestId('season-screen')).toBeVisible();
  const seasonPath = pathOf(page);
  await page.locator('[data-testid="episode-row"][data-number="1"]').click();
  await page.getByTestId('nas-play').click();
  await waitForPlaying(page);
  await page.goBack();
  await expect(page.getByTestId('season-screen')).toBeVisible({ timeout: 15_000 });
  // Forward onto the play link: its own pre-flight, in the same page.
  await page.goForward();
  await expect(page.getByTestId('nas-play-link')).toBeVisible({ timeout: 15_000 });
  // The disc's reads are held, so the open is still in flight when Back comes.
  const held: Route[] = [];
  await context.route(/\/api\/discs\/[^/]+\/files\//, (route) => void held.push(route));
  await page.getByTestId('nas-play').click();
  await expect(page.getByText('Reading disc…')).toBeVisible();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await page.goBack();
  await expect(page.getByTestId('season-screen')).toBeVisible({ timeout: 15_000 });
  expect(pathOf(page)).toBe(seasonPath);
  await context.unroute(/\/api\/discs\/[^/]+\/files\//);
  for (const route of held) await route.continue().catch(() => {});
  // Nothing comes of the abandoned open, and the address bar stays where Back went.
  await page.waitForTimeout(3000);
  await expect(playerState(page)).toHaveCount(0);
  await expect(page.getByTestId('season-screen')).toBeVisible();
  expect(pathOf(page)).toBe(seasonPath);
});

test('a play link starts at its time even when First Play plays something first', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page);
  // disc-menu's First Play runs its top menu (playlist 00001); the link names the feature, 00000.
  await page.goto(`/nas/play/${syntheticDiscKey('disc-menu')}?pl=00000&t=2&telemetry=1`);
  await page.getByTestId('nas-play').click({ timeout: 15_000 });
  await waitForPlaying(page);
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
  await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 1_000, intervals: [100] }).toBeGreaterThanOrEqual(2_000_000);
  await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
});

test('a play link with a bad time or playlist opens the disc without seeking', async ({ page, browserName }) => {
  await openTitles(page, browserName);
  await skipWithoutH264(page);
  const key = disc1Key();
  for (const t of ['-5', '99999']) {
    await page.goto(`/nas/play/${key}?pl=00000&t=${t}&telemetry=1`);
    await page.getByTestId('nas-play').click({ timeout: 15_000 });
    await waitForPlaying(page);
    await expect(playerState(page)).toHaveAttribute('data-playlist', '00000');
    // Playing from the start: well short of any seek once it has played a moment.
    await expect.poll(async () => (await telemetry(page))?.clockUs ?? 0, { timeout: 5_000 }).toBeGreaterThan(500_000);
    expect((await telemetry(page))!.clockUs).toBeLessThan(2_500_000);
  }
  await page.goto(`/nas/play/${key}?pl=99999`);
  await page.getByTestId('nas-play').click({ timeout: 15_000 });
  await expect(page.getByTestId('playlist-00000')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("This episode isn't on this disc; it opened normally.")).toBeVisible();
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
      await expect(notice).toBeFocused();
      await expect(page.getByTestId('unsorted-apply-disc')).toHaveValue('1');
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

test('an owner files a disc differently from its season, into Music, and out of the library from the Music shelf', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = OWNER_SERIES[project];
  const [first] = ownerDiscs(project).series.map(lastSegment) as [string, string];
  await exclusivelyAsync('catalogue', async () => {
    let id: string | null = null;
    try {
      // File the series' first disc from Unsorted: Season starts at the suggestion's season (ruling F2).
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, first);
      id = await card.getAttribute('data-disc-id');
      await card.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
      await expect(card.getByTestId('unsorted-season')).toHaveValue('1');
      await card.getByTestId('unsorted-disc').fill('1');
      await card.getByTestId('unsorted-file').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText(`Filed under ${name}.`);
      await page.getByRole('button', { name: 'Back to the library' }).click();

      // From the season, "File differently…" moves it to Music; the series, now empty, is gone.
      await page.locator(`[data-testid="title-card"][data-name="${name}"]`).click();
      await page.getByTestId('season-row').first().click();
      const discsTab = page.locator('[data-testid="season-tab"][data-tab="discs"]');
      if ((await discsTab.count()) > 0) await discsTab.click();
      const discCard = page.getByTestId('disc-card');
      await expect(discCard).toHaveCount(1);
      await discCard.getByTestId('disc-refile').click();
      await discCard.getByTestId('unsorted-card').getByTestId('unsorted-music').click();
      await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
      await expect(page.locator(`[data-testid="title-card"][data-name="${name}"]`)).toHaveCount(0);

      // On the Music shelf, "File differently…" and "Don't list" take it out of the library.
      await shelfChip(page, 'music').click();
      const row = page.locator(`[data-testid="music-row"][data-name="${first}"]`);
      await expect(row).toBeVisible();
      await row.getByTestId('music-refile-open').click();
      await row.getByTestId('unsorted-card').getByTestId('unsorted-hide').click();
      await expect(row).toHaveCount(0);
      const hidden = (await (await ownerApi('admin/hidden')).json()) as { discs: { discId: string }[] };
      expect(hidden.discs.map((d) => d.discId)).toContain(id);

      // Filed under the series again, in the same visit: the series that went away opens again.
      await clearChoices([id]);
      await shelfChip(page, 'unsorted').click();
      const again = unsortedCard(page, first);
      await again.locator(`[data-testid="title-option"][data-name="${name}"]`).click();
      await again.getByTestId('unsorted-disc').fill('1');
      await again.getByTestId('unsorted-file').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText(`Filed under ${name}.`);
      await page.getByRole('button', { name: 'Back to the library' }).click();
      await shelfChip(page, 'music').click(); // the Music shelf was picked: unpick it, back to the whole library
      await page.locator(`[data-testid="title-card"][data-name="${name}"]`).click();
      await expect(page.getByTestId('series-name')).toHaveText(name);
      await expect(page.getByTestId('season-row')).toHaveCount(1);
    } finally {
      await clearChoices([id]);
    }
  });
});

test('"New title…" makes a Music title; "Don\'t list" hides a disc and Unhide brings it back', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const stray = ownerStray(project);
  await exclusivelyAsync('catalogue', async () => {
    let strayId: string | null = null;
    try {
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, stray);
      strayId = await card.getAttribute('data-disc-id');
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
      await unsortedCard(page, stray).getByTestId('unsorted-hide').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText('Not listed.');
      await expect(unsortedCard(page, stray)).toHaveCount(0);
      await page.getByTestId('open-hidden').click();
      const row = page.locator(`[data-testid="hidden-row"][data-folder="${stray}"]`);
      await expect(row).toBeVisible();
      await row.getByTestId('hidden-unhide').click();
      await expect(row).toHaveCount(0);
      // focus goes to the next row or the heading, not back to the top of the page
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid="hidden-screen"]') !== null)).toBe(true);
      await page.getByRole('button', { name: 'Back to Unsorted' }).click();
      await expect(unsortedCard(page, stray)).toBeVisible();
    } finally {
      await clearChoices([strayId]);
      const own = (await (await ownerApi(`admin/lookup?q=${encodeURIComponent('Live 2024')}&source=own`)).json()) as { titles: { id: string }[] };
      for (const t of own.titles) await ownerApi(`admin/titles/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    }
  });
});

test('renaming a music title shows the new name on the Music shelf and in search', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const stray = ownerStray(project);
  await exclusivelyAsync('catalogue', async () => {
    let strayId: string | null = null;
    let musicId: string | null = null;
    try {
      await openUnsorted(page, browserName);
      const card = unsortedCard(page, stray);
      strayId = await card.getAttribute('data-disc-id');
      await card.getByTestId('unsorted-music').click();
      await expect(page.getByTestId('unsorted-notice')).toContainText('Marked as Music.');
      await page.getByRole('button', { name: 'Back to the library' }).click();
      await shelfChip(page, 'music').click();

      const row = page.locator(`[data-testid="music-row"][data-name="${stray}"]`);
      await expect(row).toContainText(`syn · Owner/${project}/${stray}`);
      musicId = await row.locator('button[data-title-id]').getAttribute('data-title-id');
      await row.getByRole('button', { name: `Rename ${stray}` }).click();
      await row.getByLabel('Display name').fill('Reel Session');
      await row.getByTestId('music-save').click();
      const renamed = page.locator('[data-testid="music-row"][data-name="Reel Session"]');
      await expect(renamed).toContainText(`Renamed · was ${stray}`);
      await expect(renamed.getByTestId('music-rename')).toBeFocused();

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
      await clearChoices([strayId]);
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
  // Turning it off is the safe direction: no confirm (ruling T11j).
  await gate.click();
  await expect(gate).not.toBeChecked();
  await expect(page.getByTestId('nas-gate-confirm')).toHaveCount(0);
  expect(sent).toEqual([{ gate: 'everyone' }, { gate: 'owners' }]);
}

test('a hidden copy explains what it follows, and "apply to the folder" lists the discs it left', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = OWNER_SERIES[project];
  const [first, second] = ownerDiscs(project).series.map(lastSegment) as [string, string];
  let secondId: string | null = null;
  const applied: unknown[] = [];
  const cors = (): Record<string, string> => ({ 'Access-Control-Allow-Origin': new URL(page.url()).origin });
  // Stubbed answers: the NAS's own refusals (copies need two discs with one fingerprint) and nothing changed for real.
  await page.route('**/api/admin/discs/*/choice', async (route) => {
    const req = route.request();
    if (req.method() === 'DELETE') return route.fulfill({ status: 409, headers: cors(), json: { error: 'copy-follows-source', source: 'src-disc' } });
    const body = req.postDataJSON() as { choice: unknown; applyToGroup?: boolean };
    if (body.applyToGroup) applied.push(body.choice);
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
  // Filed with no disc number: Apply waits for one (ruling T11h), and numbers the others from it.
  await card.getByTestId('unsorted-file').click();
  const apply = page.getByTestId('unsorted-apply');
  await expect(apply).toBeDisabled();
  await expect(page.getByTestId('unsorted-apply-hint')).toHaveText("Enter this disc's number first");
  await page.getByTestId('unsorted-apply-disc').fill('0');
  await expect(apply).toBeDisabled();
  await page.getByTestId('unsorted-apply-disc').fill('3');
  await expect(page.getByTestId('unsorted-apply-hint')).toHaveCount(0);
  await apply.click();
  await expect(page.getByTestId('unsorted-notice')).toContainText('No other disc in this folder was filed.');
  expect(applied).toEqual([{ kind: 'title', titleId: `anilist:${900111 + PROJECTS.indexOf(project)}`, season: 1, disc: 3 }]);
  await expect(page.getByTestId('unsorted-skipped')).toHaveText(`${second} (filed separately)`);

  await page.getByTestId('open-hidden').click();
  const copy = page.locator('[data-testid="hidden-row"][data-folder="Copy Disc"]');
  await copy.getByTestId('hidden-unhide').click();
  await expect(copy.getByTestId('hidden-follows')).toContainText('This disc follows its copy at syn/Owner/Source Disc');
  await expect(copy.getByTestId('hidden-own')).toHaveText("Don't list this copy");
  await copy.getByTestId('hidden-file').click();
  await expect(copy.getByTestId('unsorted-card')).toBeVisible();
});

test('NAS settings list own titles, to rename, change seasons and delete after a confirm', async ({ page, browserName }, testInfo) => {
  const project = projectOf(testInfo.project.name);
  const name = `Harbor Tales ${project}`;
  await exclusivelyAsync('catalogue', async () => {
    const created = (await (await ownerApi('admin/titles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'series', name, seasons: 2 }) })).json()) as { id: string };
    try {
      await openTitles(page, browserName);
      await page.getByTestId('nas-settings').click();
      const row = page.locator(`[data-testid="nas-own-title"][data-name="${name}"]`);
      await expect(row).toContainText('Series · 2 seasons');

      await row.getByRole('button', { name: `Rename ${name}` }).click();
      await row.getByRole('textbox', { name: 'Name' }).fill(`${name} Redux`);
      await row.getByTestId('nas-own-save').click();
      const renamed = page.locator(`[data-testid="nas-own-title"][data-name="${name} Redux"]`);
      await expect(renamed).toBeVisible();

      await renamed.getByRole('button', { name: `Seasons of ${name} Redux` }).click();
      await renamed.getByRole('textbox', { name: 'Seasons' }).fill('3');
      await renamed.getByTestId('nas-own-save').click();
      await expect(renamed).toContainText('Series · 3 seasons');

      await renamed.getByRole('button', { name: `Delete ${name} Redux` }).click();
      await expect(renamed).toContainText(`Delete ${name} Redux? Its discs go back to Unsorted.`);
      await renamed.getByRole('button', { name: 'Cancel' }).click();
      await expect(renamed).toBeVisible();
      await renamed.getByRole('button', { name: `Delete ${name} Redux` }).click();
      await renamed.getByTestId('nas-own-delete-confirm').click();
      await expect(renamed).toHaveCount(0);

      // the library fetches its titles again: the deleted title is gone from search
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByTestId('title-search').fill(name);
      await expect(page.getByTestId('title-row')).toHaveCount(0);
    } finally {
      await ownerApi(`admin/titles/${encodeURIComponent(created.id)}`, { method: 'DELETE' });
    }
  });
});

const NOT_FOUND_COPY = "This link is for a NAS this device isn't paired with. Ask its owner to send you an invite.";
const MISSING_COPY = "Your NAS doesn't have what this link points to. It may have been removed or renamed, or the link may be for a different NAS.";
const CLOSED_COPY = "The NAS owner hasn't opened the title library to this device, so this link can't open here. You can still browse the NAS by folder.";

test('a NAS link on an unpaired device asks for an invite', async ({ page }) => {
  await page.goto('/nas/title/anilist%3A1');
  await expect(page.getByTestId('nas-not-found')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('nas-not-found').locator('p')).toHaveText(NOT_FOUND_COPY);
  await expect(page.getByTestId('pair-screen')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pair with a NAS' }).click();
  await expect(page.getByTestId('pair-screen')).toBeVisible();
  await expect(page.getByTestId('nas-not-found')).toHaveCount(0);
  expect(pathOf(page)).toBe('/');
});

test('a link to something the NAS does not have says so, and leads back to the library', async ({ page, browserName }) => {
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  await pairByLink(page);
  await page.goto('/nas/play/d.0000000000000000');
  await expect(page.getByTestId('nas-not-found').locator('p')).toHaveText(MISSING_COPY, { timeout: 15_000 });
  await page.goto('/nas/title/anilist%3A999999999');
  await expect(page.getByTestId('nas-not-found').locator('p')).toHaveText(MISSING_COPY, { timeout: 15_000 });
  // Paired, the button leads back to the library instead of the pair screen.
  await page.getByRole('button', { name: 'Back to the library' }).click();
  await expect(page.getByTestId('title-library')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('nas-paired')).toBeVisible();
  expect(pathOf(page)).toBe('/nas');
});

test('a guest behind the closed title gate gets not-found for a title link', async ({ page, browser, browserName }) => {
  await libraryReady();
  await allowLocalNetwork(page, browserName);
  await pairByLink(page);
  const res = await ownerApi('admin/codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPerson: { name: 'Noor', owner: false }, invite: true }),
  });
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await allowLocalNetwork(guest, browserName);
    await guest.goto('/');
    await guest.getByTestId('pair-code').fill(code);
    await guest.getByTestId('pair-button').click();
    await expect(guest.getByTestId('nas-paired')).toBeVisible({ timeout: 25_000 });
    await exclusivelyAsync('gate', async () => {
      await setGate('owners');
      await guest.goto('/nas/title/anilist%3A1');
      await expect(guest.getByTestId('nas-not-found').locator('p')).toHaveText(CLOSED_COPY, { timeout: 15_000 });
      await expect(guest.getByTestId('nas-crumbs')).toHaveCount(0);
      await guest.getByRole('button', { name: 'Browse by folder' }).click();
      await expect(guest.getByTestId('nas-crumbs')).toHaveText('NAS', { timeout: 15_000 });
      expect(new URL(guest.url()).pathname).toBe('/nas/folders');
      await guest.goto('/nas');
      await expect(guest.getByTestId('nas-crumbs')).toHaveText('NAS', { timeout: 15_000 });
      await expect(guest.getByTestId('nas-not-found')).toHaveCount(0);
    });
  } finally {
    await guestContext.close();
  }
});
