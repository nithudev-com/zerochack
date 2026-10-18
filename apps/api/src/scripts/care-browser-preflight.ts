import { runStaticBrowser } from '../modules/care/static-browser.js';
import { ApiError } from '../errors.js';
// Uses a fixed public fixture only. No customer source, provider, URL or database access.
try {
  const result = await runStaticBrowser({ source: '<!doctype html><html lang="en"><head><title>Browser readiness fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Ready</h1></main></body></html>', toolId: 'T28', viewport: 'MOBILE', privateIds: [] });
  process.stdout.write(JSON.stringify({ state: 'PASS', ...result.report, limitation: 'Sandbox startup and synthetic static rendering only. Deployment resource and network isolation require separate operator validation.' }, null, 2) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ state: 'BLOCKED', code: error instanceof ApiError ? error.code : 'BROWSER_FAILED', message: 'Browser tools remain unavailable until the pinned Chromium runtime and non-root sandbox pass this check.' }) + '\n');
  process.exitCode = 1;
}
