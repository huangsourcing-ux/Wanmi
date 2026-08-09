import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  expect: {
    timeout: 15_000,
  },
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  timeout: 120_000,
  workers: 2,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm build && pnpm start:e2e',
    reuseExistingServer: false,
    url: 'http://127.0.0.1:3100/healthz',
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: 'commerce-journey.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      dependencies: ['chromium'],
      name: 'commerce-journey',
      testMatch: 'commerce-journey.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
