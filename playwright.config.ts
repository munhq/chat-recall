import { defineConfig, devices } from '@playwright/test';

/**
 * WHERE THE BROWSERS ARE.
 *
 * Playwright looks in `~/.cache/ms-playwright` by default. On a machine where
 * they were installed under `~/.local/share/ms-playwright` instead, every
 * chromium test fails in about 2ms with "Executable doesn't exist" — and the
 * run still exits 0, because a project whose tests all fail to launch reports
 * no failures at all. The suite looked green while launching nothing.
 *
 * Honour an existing value; otherwise point at the XDG data directory the
 * install actually uses, and let Playwright fall back to its own default when
 * neither exists.
 */
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const xdg = process.env.XDG_DATA_HOME
    || (process.env.HOME ? `${process.env.HOME}/.local/share` : null);
  if (xdg) process.env.PLAYWRIGHT_BROWSERS_PATH = `${xdg}/ms-playwright`;
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',

  use: {
    // Point to the running app (dev server or docker)
    baseURL: process.env.BASE_URL || 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Mobile. The app shipped with no mobile viewport under test at all, which
    // is how a page reached production 156px wider than a 375px screen. These
    // two projects run the *.mobile.spec.ts files.
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 13'] },
      testMatch: /.*\.mobile\.spec\.ts/,
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
      testMatch: /.*\.mobile\.spec\.ts/,
    },
  ],

  // Uncomment to auto-start the dev server before tests:
  // webServer: {
  //   command: 'npm run web:dev',
  //   url: 'http://localhost:5174',
  //   reuseExistingServer: true,
  //   timeout: 60000,
  // },
});
