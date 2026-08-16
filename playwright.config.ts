import { defineConfig, devices } from '@playwright/test';

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
    // is how the landing page reached production 156px wider than a 375px
    // screen. These two projects run the specs tagged @mobile.
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
