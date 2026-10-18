import { defineConfig } from '@playwright/test';
const production = process.env.CARE_WEB_PRODUCTION === 'true';
export default defineConfig({
  testDir: './apps/web/care-e2e', timeout: 45000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3107', trace: 'retain-on-failure', ...(process.env.CARE_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.CARE_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] } } : {}) },
  webServer: { command: `npm run ${production ? 'start' : 'dev'} -w @zerochack/web -- --hostname 127.0.0.1 --port 3107`, env: { NODE_ENV: production ? 'production' : 'development' }, url: 'http://127.0.0.1:3107', reuseExistingServer: false, timeout: 120000 }
});
