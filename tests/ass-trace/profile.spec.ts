import { test } from '@playwright/test';
import { syntheticFixtures } from './fixtures';
import type { AssTracePage } from './page/types';

// ASS_PROFILE=<fixture> prints the functions with the most self time while drawing the fixture's frames
const name = process.env.ASS_PROFILE;
test.skip(!name, 'set ASS_PROFILE=<fixture>');
test('profile', async ({ page }) => {
  const fx = syntheticFixtures().find((f) => f.name === name)!;
  await page.goto('/tests/ass-trace/page/index.html');
  await page.waitForFunction(() => 'assTrace' in window);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  await page.evaluate(([s, f, t, st]) => (window as unknown as { assTrace: AssTracePage }).assTrace.run(s, f, t, true, st), [fx.script, fx.fonts, fx.times, fx.storage] as const);
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map<string, number>();
  const dt = profile.timeDeltas ?? [];
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  (profile.samples ?? []).forEach((id, i) => {
    const n = byId.get(id)!;
    const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join('\n'));
});
