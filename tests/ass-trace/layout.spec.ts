import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { compareTraces, formatDiffs } from './compare';
import { syntheticFixtures } from './fixtures';
import { parseTrace } from './format';
import type { AssTracePage } from './page/types';

for (const fx of syntheticFixtures()) {
  test(`layout matches libass: ${fx.name}`, async ({ page }) => {
    await page.goto('/tests/ass-trace/page/index.html');
    await page.waitForFunction(() => 'assTrace' in window);
    const out = await page.evaluate(
      ([s, f, t, st]) => (window as unknown as { assTrace: AssTracePage }).assTrace.run(s, f, t, false, st),
      [fx.script, fx.fonts, fx.times, fx.storage] as const,
    );
    const diffs = compareTraces(parseTrace(readFileSync(fx.golden, 'utf8')), parseTrace(out.trace), { tolerance: 0.5, missingFamilies: new Set(out.missingFamilies.map((f) => f.toLowerCase())) });
    expect(diffs, formatDiffs(diffs, 30)).toEqual([]);
  });
}
