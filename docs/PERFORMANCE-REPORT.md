# Phase 12 performance report

Date: 2026-09-03. Environment: one local Node.js 22 process, local PostgreSQL 16 and Redis 7 containers. These numbers are smoke-test observations, not production capacity guarantees.

## Measured API smoke load

Command:

```bash
LOAD_BASE_URL=http://127.0.0.1:4400 LOAD_REQUESTS=2000 LOAD_CONCURRENCY=40 npm run test:load
```

Result: 2,000/2,000 HTTP 200 responses, zero failures, 1,083.84 requests/second, p50 32.73 ms, p95 66.78 ms, p99 94.44 ms, maximum 122.42 ms against `/v1/health/live`.

The harness is in `infrastructure/load/api-load.mjs` and supports target, request count, concurrency, method, timeout, and cookie configuration through environment variables.

## Review findings

- Duplicate framework and application request logging doubled log volume under load; framework request logging was disabled while the structured completion record was retained.
- API and worker bundles initially embedded a CommonJS Undici dependency into ESM and failed at runtime. Undici and other native/runtime dependencies are now externalized; compiled API and worker startup was verified.
- Login is deliberately CPU-expensive because of Argon2id. Capacity testing must isolate an authentication pool or tune replicas without weakening the hash policy.
- Authenticated calls load session, user, tenant membership, role, and permissions. Measure these queries with production-shaped data before setting SLOs.
- In-memory metrics are per replica and reset on restart; a scraper can aggregate them, but a production observability backend is required.
- No representative scan, queue, AI, WebSocket/SSE, notification, database-contention, or frontend Core Web Vitals capacity run was completed. There is no production-shaped dataset or configured provider environment.

## Release gates

Define latency/error SLOs; run mixed authenticated traffic; load queue producers and workers; test Argon2 saturation; measure database pool exhaustion and N+1 behavior; test SSE connection count; run mobile Lighthouse/Core Web Vitals; and establish maximum safe concurrency for each external provider before launch.

