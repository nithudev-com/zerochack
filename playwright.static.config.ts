import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './apps/api/browser-e2e', fullyParallel: false, workers: 1, use: { ...(process.env.CARE_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.CARE_CHROMIUM_EXECUTABLE } } : {}) }, retries: 0, timeout: 30000, reporter: 'list' });
