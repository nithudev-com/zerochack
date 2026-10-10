import { defineConfig } from '@playwright/test';

// Browser origin, API allowlist and cookie site must use the same loopback host.
const webPort = Number(process.env.E2E_WEB_PORT ?? 3000);
const apiPort = Number(process.env.E2E_API_PORT ?? 4000);
if (![webPort, apiPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)) throw new Error('Invalid E2E port');
const webOrigin = `http://127.0.0.1:${webPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}/v1`;

export default defineConfig({
  testDir: './apps/web/e2e',
  timeout: 60_000,
  globalSetup: './apps/web/e2e/setup.ts',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: webOrigin, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run dev -w @zerochack/api', url: `${apiUrl}/health/live`, env: { API_HOST: '127.0.0.1', API_PORT: String(apiPort), CORS_ORIGINS: webOrigin, CARE_ENABLED: 'true' }, reuseExistingServer: !process.env.CI },
    { command: `npm run dev -w @zerochack/web -- --hostname 127.0.0.1 --port ${webPort}`, url: webOrigin, env: { NEXT_PUBLIC_API_URL: apiUrl }, reuseExistingServer: !process.env.CI }
  ]
});
