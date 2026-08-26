import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/visual',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  outputDir: 'test-results/task-center',
  use: {
    baseURL: 'http://127.0.0.1:8791',
    browserName: 'chromium',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node dist/cli/rhinoq.js dev --demo --port=8791',
      url: 'http://127.0.0.1:8791/task-center',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'node dist/cli/rhinoq.js dev --demo --port=18891',
      url: 'http://127.0.0.1:18891/tasks',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm --prefix ../../examples/react-vite-task-center run preview',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
