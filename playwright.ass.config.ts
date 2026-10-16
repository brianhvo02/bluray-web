import { defineConfig } from '@playwright/test';

/** The ASS trace comparisons: our port in Chrome against libass goldens, on a Vite dev server. */
export default defineConfig({
  testDir: 'tests/ass-trace',
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  use: { baseURL: 'http://localhost:5174', channel: 'chrome' },
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174/tests/ass-trace/page/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
