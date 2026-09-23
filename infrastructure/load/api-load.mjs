import { performance } from 'node:perf_hooks';

const baseUrl = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:4000';
const path = process.env.LOAD_PATH ?? '/v1/health/live';
const requests = Number.parseInt(process.env.LOAD_REQUESTS ?? '1000', 10);
const concurrency = Number.parseInt(process.env.LOAD_CONCURRENCY ?? '25', 10);
const method = process.env.LOAD_METHOD ?? 'GET';
const timeoutMs = Number.parseInt(process.env.LOAD_TIMEOUT_MS ?? '5000', 10);

if (!Number.isSafeInteger(requests) || requests < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > requests) {
  throw new Error('LOAD_REQUESTS and LOAD_CONCURRENCY must be positive integers, with concurrency no greater than requests');
}

const latencies = [];
const statuses = new Map();
let failures = 0;
let next = 0;

async function worker() {
  while (next < requests) {
    next += 1;
    const started = performance.now();
    try {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: process.env.LOAD_COOKIE ? { cookie: process.env.LOAD_COOKIE } : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
      await response.arrayBuffer();
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      if (!response.ok) failures += 1;
    } catch {
      failures += 1;
    } finally {
      latencies.push(performance.now() - started);
    }
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const durationMs = performance.now() - started;
latencies.sort((a, b) => a - b);
const percentile = (value) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)];
const result = {
  target: new URL(path, baseUrl).toString(), requests, concurrency,
  durationMs: Number(durationMs.toFixed(2)), requestsPerSecond: Number((requests / (durationMs / 1000)).toFixed(2)),
  latencyMs: { p50: Number(percentile(0.5).toFixed(2)), p95: Number(percentile(0.95).toFixed(2)), p99: Number(percentile(0.99).toFixed(2)), max: Number(latencies.at(-1).toFixed(2)) },
  statuses: Object.fromEntries([...statuses].sort(([a], [b]) => a - b)), failures
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (failures > 0) process.exitCode = 1;
