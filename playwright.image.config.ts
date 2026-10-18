import { defineConfig } from '@playwright/test';

process.env.CARE_WEB_PRODUCTION = 'true';

// Start the exact production web image separately on this loopback port.
// This suite uses UI fixtures; it does not certify live providers or Owner setup.
export default defineConfig({
  testDir: './apps/web/care-e2e', timeout: 45000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3510', trace: 'retain-on-failure' }
});
