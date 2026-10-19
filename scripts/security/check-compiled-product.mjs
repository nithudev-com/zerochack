import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';

// Exercise the compiled ESM/CJS boundary and protected product registration.
// No database, Redis, provider, SSH or customer target is contacted.
const reservation = createServer();
await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
const child = spawn(process.execPath, [resolve('apps/api/dist/server.js')], {
  env: { PATH: process.env.PATH, NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: String(port),
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/compiled_no_database', REDIS_URL: 'redis://127.0.0.1:1',
    SESSION_SECRET: randomBytes(32).toString('base64url'), CORS_ORIGINS: `http://127.0.0.1:${port}`, LOG_LEVEL: 'silent' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '', finished = false;
child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-8192); });
child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-8192); });
child.once('exit', () => { finished = true; });
try {
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline && !finished) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/auth/me`, { signal: AbortSignal.timeout(500) });
      if (response.status === 401) { ready = true; break; }
    } catch { /* Startup has a bounded retry; no application mutation is retried. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  assert(ready, `Compiled API did not start with protected authentication: ${output}`);
  const response = await fetch(`http://127.0.0.1:${port}/v1/websites/00000000-0000-4000-8000-000000000001/security-repair/capabilities`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 401, 'Compiled security repair routes must require authentication');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
  process.stdout.write('Compiled product bootstrap and unauthenticated-route checks passed. No external effect ran.\n');
} finally {
  if (!finished) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(done => setTimeout(done, 3000))]);
    if (!finished) child.kill('SIGKILL');
  }
}
