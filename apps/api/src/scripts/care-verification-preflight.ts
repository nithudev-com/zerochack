import { runVerification } from '../modules/care/verification-runner.js';
import type { Environment } from '@zerochack/config';
import { ApiError } from '../errors.js';
// No database or customer input. Uses the exact production adapter and a fixed fixture.
try {
  const result = await runVerification({ policy: 'offline-verification-v1', toolId: 'T35', files: [{ path: 'test/unit.test.mjs', content: `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { networkInterfaces } from 'node:os';
test('isolation', () => {
  assert.equal(process.getuid(), 65532);
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
  const status = readFileSync('/proc/self/status', 'utf8');
  assert.match(status, /NoNewPrivs:\\s+1/); assert.match(status, /Seccomp:\\s+2/); assert.match(status, /CapEff:\\s+0+\\n/);
  const root = readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').map(line => line.split(' ')).find(parts => parts[4] === '/'); assert.ok(root[5].split(',').includes('ro'));
  assert.equal(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), '268435456');
  assert.equal(readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(), '64');
  const cpu = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ').map(Number); assert.equal(cpu[0] / cpu[1], 1);
  assert.equal(process.env.DATABASE_URL, undefined); assert.equal(process.env.SESSION_SECRET, undefined);
});` }] }, { CARE_VERIFICATION_IMAGE: process.env.CARE_VERIFICATION_IMAGE } as Environment);
  if (result.outcome !== 'PASSED') throw new Error('fixture');
  process.stdout.write(JSON.stringify({ state: 'PASS', result, limitation: 'Confirms the production rootless adapter and this fixed Node fixture only. Test each supported profile and approved WordPress reference on the actual deployment before activation.' }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ state: 'BLOCKED', code: error instanceof ApiError ? error.code : 'VERIFICATION_FAILED' }) + '\n'); process.exitCode = 1;
}
