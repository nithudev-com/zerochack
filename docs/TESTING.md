# Testing

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run test:load
npm run build
npm run openapi:generate
```

Unit and API-injection tests do not require network services. Integration tests require the isolated PostgreSQL described in `.env.test.example` and committed migrations. Copy that example to `.env.test` or export its values before running the suite. The destructive integration setup refuses to run unless the database name ends in `_test`; never point it at development or production. E2E tests require Playwright's Chromium binary (`npx playwright install chromium`) and start the API and web app automatically. Its global setup creates an isolated, approved customer fixture only in the test database; application runtime never seeds fake customer or security data.

Tests must be deterministic and isolated. Do not point test configuration at development or production resources. Phase 1 integration coverage exercises email verification and reset replay, session expiry/revocation, portal role mismatch, approval/suspension, Owner MFA enrollment and one-use recovery, Owner-route privilege escalation, altered tenant UUID/header access, and explicit agency grant policy.

Phase 2 integration coverage uses separate real tenants and attempts cross-tenant website reads, edits, archive operations, chat, scan submission, query manipulation, and forged tenant headers. Playwright covers the customer journey and a mobile viewport.

Phase 3 unit coverage includes private/reserved IPv4 and IPv6, metadata targets, internal DNS, mixed-answer rebinding, redirect scope abuse, protocol/port policy, engine normalization, secret redaction, and retry policy. Integration coverage exercises verification-token hashing, verified-only and duplicate scan authorization, queue-to-engine persistence, evidence integrity, and evidence isolation. A real external read-only worker test is opt-in: `RUN_LIVE_SCAN=true npx vitest run --config vitest.integration.config.ts apps/worker/src/live-scan.integration.test.ts`.

Phase 4 unit coverage exercises role policy, Affiliate security-context denial, prompt/evidence secret redaction, disabled credentials, layered limits, provider 429 behavior, same-credential transient retry, and idempotent duplicate requests. Integration coverage sends a real authenticated tenant-scoped AI chat through an injected provider adapter, verifies persisted usage and redaction, and proves another tenant cannot reference that website or finding. Tests never call a live AI provider.

Phase 5 gate tests cover missing/expired or mismatched authorization, wrong website/ticket, failed backup verification, expired/revoked sessions, and scope enforcement. PostgreSQL integration exercises atomic double-acceptance prevention, pre-authorization backup denial, expired grants, and cross-tenant authorization denial.

Phase 6 integration coverage exercises duplicate and invalid webhooks, replay rejection, duplicate checkout/payment/refund behavior, provider-confirmed cancellation, quote transitions, historical prices, and cross-tenant denial. Tests use an injected deterministic adapter and never claim an external payment occurred.

Phase 7 coverage verifies encrypted bytes at the object-storage boundary, tenant-bound authenticated encryption, backup/provider failure, restore failure, retention and restore-point limits, cross-tenant backup denial, duplicate monitoring jobs, cooldown suppression during alert storms, persisted notifications/escalations, scheduler failure, and audited Developer Mode diagnostics.

## Phase 12 verification record

On 2026-09-03: lint and workspace typecheck passed; 76 unit/API-injection tests passed; all 12 migrations applied to an empty PostgreSQL 16 database; 13 enabled PostgreSQL/Redis integration tests passed and the opt-in live internet scan remained skipped; all 7 Playwright journeys passed, including mobile, Owner MFA, agency, and affiliate navigation; API, web, and worker builds passed; compiled API and worker processes started; and the generated OpenAPI 3.0.3 document contained 155 paths. See `SECURITY-TEST-REPORT.md` and `PERFORMANCE-REPORT.md` for scope and limitations.
