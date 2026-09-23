import { defineConfig } from '@playwright/test';

// Browser origin, API allowlist and cookie site must use the same loopback host.
const webOrigin = 'http://127.0.0.1:3000';
const apiUrl = 'http://127.0.0.1:4000/v1';

export default defineConfig({
  testDir: './apps/web/e2e',
  timeout: 60_000,
  globalSetup: './apps/web/e2e/setup.ts',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: webOrigin, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run dev -w @zerochack/api', url: `${apiUrl}/health/live`, env: { API_HOST: '127.0.0.1', API_PORT: '4000', CORS_ORIGINS: webOrigin }, reuseExistingServer: !process.env.CI },
    { command: 'npm run dev -w @zerochack/web -- --hostname 127.0.0.1 --port 3000', url: webOrigin, env: { NEXT_PUBLIC_API_URL: apiUrl }, reuseExistingServer: !process.env.CI }
  ]
});
