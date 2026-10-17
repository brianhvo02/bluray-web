import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // The service worker's install and precache would run during the A/V sync tests; offline.spec.ts allows it.
  // CI keeps a trace of each failure (uploaded with test-results/): a stall that only CI shows can be read step by step.
  use: { baseURL: 'http://localhost:4173', serviceWorkers: 'block', trace: process.env.CI ? 'retain-on-failure' : 'off' },
  projects: [
    {
      name: 'chromium',
      testIgnore: /mobile-.*\.spec\.ts/,
      use: { channel: 'chrome', launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
    },
    {
      name: 'firefox',
      testIgnore: /mobile-.*\.spec\.ts/,
      use: { ...devices['Desktop Firefox'], launchOptions: { firefoxUserPrefs: { 'media.autoplay.default': 0 } } },
    },
    {
      name: 'webkit',
      testIgnore: /mobile-.*\.spec\.ts/,
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-chromium',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { ...devices['Pixel 7'], channel: 'chrome', hasTouch: true, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
