/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { createDiscHandler, servedDiscBase } from '../../tools/disc-server/server';
import { settlesOn } from './bdj-support';
import { setFolder, skipWithoutH264 } from './support';

// fixtures/synthetic/disc-bdj-store (scripts/make-bdj-store-disc.ts): StoreXlet counts its own openings. It reads
// /persistent/<org>/<app>/count (the path built from dvb.persistent.root and its xlet properties, as libbluray's
// BDJAppProxy makes it) and the lines of the organisation's loose BUDA file /buda/<org>/x.log, draws both
// ("count <c>  log <l>"), writes c + 1 and a line more, and only then plays playlist 00000. What it saved lasts in
// IndexedDB (BdjStore, ruling R1): the next opening in the same browser shows the next count.
//
// The plane hashes are libbluray's for three openings on one storage (tests/bdj/golden/disc-bdj-store.open.<n>.jsonl,
// npm run bdj-trace:golden): equal hashes prove both numbers came back, and that the plane matches libbluray's.

const STORE_DISC = 'fixtures/synthetic/disc-bdj-store';
const ORG = '7fff0002';

/** The settled plane libbluray drew at its n-th opening (0: "count 0  log 0"). */
const OPENED: readonly string[] = [1, 2, 3].map((n) => {
  const lines = readFileSync(new URL(`../bdj/golden/disc-bdj-store.open.${n}.jsonl`, import.meta.url), 'utf8').trim().split('\n');
  const end = lines.map((l) => JSON.parse(l) as { script?: string; hash?: string }).find((e) => e.script === 'end');
  if (!end?.hash) throw new Error(`disc-bdj-store.open.${n}.jsonl has no end hash`);
  return end.hash;
});

/** Opens the disc from the folder input of a page on the landing screen (the `local` source). */
async function openLocal(page: Page): Promise<void> {
  await expect(page.getByTestId('folder-input')).toBeAttached({ timeout: 15_000 });
  await setFolder(page.getByTestId('folder-input'), STORE_DISC);
}

/** Loads the player (fresh, as a viewing starts) and opens the disc from the folder. */
async function view(page: Page): Promise<void> {
  await page.goto('/?telemetry=1');
  await skipWithoutH264(page);
  await openLocal(page);
}

/**
 * Waits for StoreXlet's playlist, which it starts right after its write (a `playlist` event, not telemetry, so it is
 * seen tens of milliseconds after Java wrote), and returns Date.now() then.
 */
async function written(page: Page): Promise<number> {
  await page.waitForFunction(() => document.querySelector('[data-testid="player"]')?.getAttribute('data-playlist') === '00000', null, { polling: 'raf', timeout: 30_000 });
  return Date.now();
}

/** Back to the landing screen, as a person closes the disc (the BD-J stop saves before the next boot loads). */
async function closeDisc(page: Page): Promise<void> {
  // the count shows as a BD-J menu, over which a pointer or a tap wakes the controls only at the bottom edge
  const box = (await page.getByTestId('player').boundingBox())!;
  const edge = { x: box.x + box.width / 2, y: box.y + box.height - 4 };
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await page.touchscreen.tap(edge.x, edge.y);
  else await page.mouse.move(edge.x, edge.y);
  await page.getByRole('button', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: 'Open another disc' }).click();
  await expect(page.getByTestId('landing')).toBeVisible();
}

interface StoredFile {
  readonly path: string;
  readonly mtime: number;
  readonly text: string;
}

/**
 * A scope's record in the page's IndexedDB (database bdj-store, src/engine/bdj/store/idb-store.ts): its files and when
 * it was saved; null when there is none. Never creates the database (an upgrade is aborted), so the engine's own open
 * still makes it with its object store.
 */
async function storedScope(page: Page, source: string, scope: string): Promise<{ savedAt: number; files: StoredFile[] } | null> {
  return page.evaluate(
    ({ key }) =>
      new Promise<{ savedAt: number; files: StoredFile[] } | null>((resolve, reject) => {
        const r = indexedDB.open('bdj-store');
        r.onupgradeneeded = () => r.transaction!.abort(); // no database yet: leave it so
        r.onerror = (e) => {
          e.preventDefault();
          resolve(null);
        };
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('scopes')) {
            db.close();
            resolve(null);
            return;
          }
          const get = db.transaction('scopes', 'readonly').objectStore('scopes').get(key);
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            db.close();
            const rec = get.result as { savedAt: number; files: { path: string; mtime: number; bytes: Uint8Array }[] } | undefined;
            resolve(rec ? { savedAt: rec.savedAt, files: rec.files.map((f) => ({ path: f.path, mtime: f.mtime, text: new TextDecoder().decode(f.bytes) })) } : null);
          };
        };
      }),
    { key: `${source}|${scope}` },
  );
}

/** Waits until the app's count `want` is stored for `source`: a navigation after it starts the next viewing from it. */
async function stored(page: Page, source: string, want: number): Promise<void> {
  await expect
    .poll(async () => (await storedScope(page, source, `persistent/${ORG}`))?.files.find((f) => f.path === '4001/count')?.text ?? null, { timeout: 15_000 })
    .toBe(String(want));
}

test.describe('saved data across viewings (disc-bdj-store)', () => {
  test('a count saved in one viewing is there in the next: the disc closed and reopened, then the page reloaded', async ({ page }) => {
    test.setTimeout(120_000);
    await view(page);
    await written(page);
    await settlesOn(page, OPENED[0]!);
    await closeDisc(page);
    await openLocal(page);
    await settlesOn(page, OPENED[1]!, 30_000);
    await stored(page, 'local', 2);
    await page.reload();
    await openLocal(page);
    await settlesOn(page, OPENED[2]!, 30_000);
    // what the browser keeps: the app's count and the organisation's loose BUDA file (ruling R14), each in its scope
    await stored(page, 'local', 3);
    expect((await storedScope(page, 'local', `persistent/${ORG}`))?.files.map((f) => f.path)).toEqual(['4001/count']);
    expect((await storedScope(page, 'local', `buda/${ORG}`))?.files.map((f) => [f.path, f.text])).toEqual([['x.log', 'opened\n'.repeat(3)]]);
  });

  // Review Focus 3 (ruling R1): the page goes 0.5 s after Java's write, well inside the plan's 2 s debounce. The flush
  // on pagehide cannot keep it in Chrome and Safari (they drop IndexedDB transactions started then, and terminate the
  // workers the flush crosses): the browser's store saves 100 ms after the write instead (IDB_SAVE_DEBOUNCE_MS), so the
  // save is on disk before the page goes. Two ways a page goes: its tab closes, or it navigates away.
  for (const how of ['closed', 'navigated away'] as const) {
    test(`a page ${how} 0.5 s after the disc saved keeps the save`, async ({ context, page }) => {
      await view(page);
      const at = await written(page);
      await page.waitForTimeout(Math.max(0, at + 500 - Date.now()));
      const goneAt = Date.now();
      let next: Page;
      if (how === 'closed') {
        // runBeforeUnload: the page is closed as a tab is, with its pagehide (without it Playwright skips the unload handlers)
        // the tab goes without its unload handlers (Playwright's default), as a killed tab does: the save cannot lean on
        // pagehide. (With runBeforeUnload, WebKit never closes a page that plays.) Another tab stays open.
        next = await context.newPage();
        await page.close();
      } else {
        await page.goto('about:blank');
        next = page;
      }
      await next.goto('/?telemetry=1');
      // the first viewing's record, before the second viewing replaces it: Java's write (the file's mtime, the BD-J
      // worker's clock) and the save, against the moment the page went (the same machine's clock)
      const scope = await storedScope(next, 'local', `persistent/${ORG}`);
      const count = scope?.files.find((f) => f.path === '4001/count');
      expect(count?.text).toBe('1');
      const wrote = count!.mtime;
      console.log(`bdj-store ${how} (${test.info().project.name}): saved ${Math.round(scope!.savedAt - wrote)} ms after the write, the page went ${Math.round(goneAt - wrote)} ms after it`);
      expect(goneAt - wrote).toBeLessThan(2_000); // inside the plan's debounce: a 2 s save would have been lost
      expect(scope!.savedAt).toBeLessThanOrEqual(goneAt);
      await openLocal(next);
      await settlesOn(next, OPENED[1]!, 30_000);
    });
  }
});

test.describe('saved data per source (disc-bdj-store on the dev disc server)', () => {
  // tools/disc-server serves the built player and the disc on one origin, so the picked folder (`local`) and the
  // server's copy (`nas:<discId>`) share one IndexedDB and differ only in their source
  const TOKEN = 'e2e-bdj-store-token';
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

  test('the picked folder and the server copy of one disc keep their own counts', async ({ page }) => {
    test.setTimeout(180_000);
    const base = await servedDiscBase(origin, TOKEN, 'disc-bdj-store');
    const discId = new URL(base).pathname.split('/').filter(Boolean).at(-1)!;
    const link = `${origin}/?telemetry=1&disc=${encodeURIComponent(base)}&token=${TOKEN}`;
    const openServer = async (): Promise<void> => {
      await page.goto(link);
      const button = page.getByTestId('server-discs').getByRole('button', { name: 'disc-bdj-store' });
      await expect(button).toBeEnabled({ timeout: 15_000 });
      await button.click();
    };
    const openFolder = async (): Promise<void> => {
      await page.goto(`${origin}/?telemetry=1`);
      await openLocal(page);
    };
    await page.goto(`${origin}/?telemetry=1`);
    await skipWithoutH264(page);
    const nas = `nas:${discId}`;
    await openFolder();
    await settlesOn(page, OPENED[0]!, 30_000);
    await stored(page, 'local', 1);
    await openServer();
    await settlesOn(page, OPENED[0]!, 30_000); // the server copy starts at 0: the folder's count is not its own
    await stored(page, nas, 1);
    await openFolder();
    await settlesOn(page, OPENED[1]!, 30_000);
    await stored(page, 'local', 2);
    await openServer();
    await settlesOn(page, OPENED[1]!, 30_000);
    await stored(page, nas, 2);
    await openServer();
    await settlesOn(page, OPENED[2]!, 30_000);
    await stored(page, nas, 3);
    await stored(page, 'local', 2);
  });
});
