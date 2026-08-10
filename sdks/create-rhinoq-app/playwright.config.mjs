import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    launchOptions: process.env.RHINOQ_PLAYWRIGHT_EXECUTABLE
      ? { executablePath: process.env.RHINOQ_PLAYWRIGHT_EXECUTABLE }
      : undefined,
  },
  snapshotPathTemplate: '{testDir}/screenshots/{arg}{ext}',
  webServer: {
    command: 'node browser/fixture.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
});
