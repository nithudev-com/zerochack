import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  timeout: 60_000,
  globalSetup: './apps/web/e2e/setup.ts',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry' },
  webServer: [
    { command: 'npm run dev -w @zerochack/api', url: 'http://127.0.0.1:4000/v1/health/live', reuseExistingServer: true },
    { command: 'npm run dev -w @zerochack/web', url: 'http://127.0.0.1:3000', reuseExistingServer: true }
  ]
});
