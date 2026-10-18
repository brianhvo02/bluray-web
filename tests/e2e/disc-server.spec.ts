import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { createDiscHandler, servedDiscBase } from '../../tools/disc-server/server';
import { skipWithoutH264 } from './support';

// tools/disc-server speaks the NAS disc API (ruling R19): a `?disc=` link opens a disc through the same client path as a
// NAS disc (the manifest, then RemoteSource range reads in the engine worker and, for a BD-J title, in the BD-J worker).
// The server also serves the built player (dist/, which the preview webServer has just built), from its own origin.

const TOKEN = 'e2e-disc-server-token';

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer(createDiscHandler({ roots: ['fixtures/synthetic'], token: TOKEN, distDir: 'dist' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('a ?disc= link plays a BD-J disc from the dev disc server, both workers reading it over HTTP', async ({ page }) => {
  const base = await servedDiscBase(origin, TOKEN, 'disc-bdj');
  const files: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(`${base}files/`)) files.push(new URL(r.url()).pathname.slice(new URL(base).pathname.length));
  });
  await page.goto(`${origin}/?telemetry=1&disc=${encodeURIComponent(base)}&token=${TOKEN}`);
  await skipWithoutH264(page);
  const button = page.getByTestId('server-discs').getByRole('button', { name: 'disc-bdj' });
  await expect(button).toBeEnabled({ timeout: 15_000 }); // once its manifest has arrived
  await button.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-state') === 'playing', null, { polling: 'raf', timeout: 30_000 });
  await expect(page.getByTestId('player')).toHaveAttribute('data-playlist', '00000'); // the playlist the disc's Java selected
  // the metadata came inlined in the manifest; the BD-J worker read the JAR and the engine the clip by range reads
  expect(files).toContain('files/BDMV/JAR/00000.JAR');
  expect(files).toContain('files/BDMV/STREAM/00000.M2TS');
  expect(files.some((f) => f.endsWith('.MPLS') || f.endsWith('.CLPI') || f.endsWith('INDEX.BDMV'))).toBe(false);
});

test('a link with a stale token lists nothing and says why', async ({ page }) => {
  await page.goto(`${origin}/?token=stale`);
  await expect(page.getByTestId('server-discs')).toContainText('401');
});
