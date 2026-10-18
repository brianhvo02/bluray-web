import { defineConfig, devices } from '@playwright/test';

/** The preview server's port: E2E_PORT moves it off 4173 when another checkout's preview is using that. */
const PORT = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // The service worker's install and precache would run during the A/V sync tests; offline.spec.ts allows it.
  use: { baseURL: `http://localhost:${PORT}`, serviceWorkers: 'block' },
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
      // the mobile specs, and the BD-J menu spec, which runs on every project
      testMatch: /(mobile-.*|bdj-menu)\.spec\.ts/,
      use: { ...devices['Pixel 7'], channel: 'chrome', hasTouch: true, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
