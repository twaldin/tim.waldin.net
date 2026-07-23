import { defineConfig, devices } from '@playwright/test';

// Browser e2e for the terminal portfolio. Targets BASE_URL (live prod by
// default; CI can point it at a preview build). Used as a deploy/merge gate.
export default defineConfig({
  testDir: '.',
  fullyParallel: false, // the backend pins one session per IP — run serially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 25_000 }, // cold welcome (figlet + pool) needs headroom
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: process.env.BASE_URL || 'https://tim.waldin.net',
    headless: true,
    ignoreHTTPSErrors: true,
    actionTimeout: 25_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
