import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { syntheticFixtures } from './fixtures';
import type { AssTracePage } from './page/types';
import { encodePng } from './png';

// ASS_SNAPSHOT=<fixture> writes our frames to test-results/ass-snapshot/<fixture>/ for a look
const name = process.env.ASS_SNAPSHOT;
test.skip(!name, 'set ASS_SNAPSHOT=<fixture> to write frames');
test('snapshot', async ({ page }) => {
  const fx = syntheticFixtures().find((f) => f.name === name)!;
  await page.goto('/tests/ass-trace/page/index.html');
  await page.waitForFunction(() => 'assTrace' in window);
  const out = await page.evaluate(([s, f, t, st]) => (window as unknown as { assTrace: AssTracePage }).assTrace.run(s, f, t, true, st), [fx.script, fx.fonts, fx.times, fx.storage] as const);
  const dir = `test-results/ass-snapshot/${fx.name}`;
  mkdirSync(dir, { recursive: true });
  fx.times.forEach((t, i) => writeFileSync(`${dir}/${t}.png`, encodePng(1920, 1080, Uint8Array.from(Buffer.from(out.frames[i]!, 'base64')))));
});
