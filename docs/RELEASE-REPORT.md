# Phase 12 release report

Date: 2026-09-03. Verdict: **not production-ready**. Core software checks pass, but provider, retention, observability, infrastructure, and staging-drill release gates remain open.

## Implemented and verified

The repository contains the Next.js portal, Fastify API, BullMQ worker, PostgreSQL migrations, Redis queue topology, authentication/session/MFA/RBAC/tenant controls, customer/agency/affiliate/specialist/Owner portals, read-only scanning, AI gateway, commercial abstractions, encrypted backup abstraction, monitoring/events, notifications/email/reporting, OpenAPI, container images, CI, security diagrams, ERD, threat model, and operational documentation.

Phase 12 hardened cross-tenant mutations and counts, live session streams, login membership handling, MFA limits/binding, specialist privileges, SSRF handling, payment idempotency/concurrency, configuration secrets/transports, browser/API headers, real system health, integration key separation, metrics, compiled packaging, container privileges, and deterministic browser tests.

## Verification summary

- Lint: pass.
- TypeScript: pass across all workspaces.
- Unit/API-injection: 76/76 pass in 15 files.
- Database migrations: 12/12 applied to an empty PostgreSQL test database.
- Integration: 13/13 enabled tests pass; one opt-in live internet scan skipped by design.
- Build: API, 78-page Next.js application, and worker pass.
- Compiled-process smoke: API and worker start and stop cleanly.
- Containers: API, web, worker, and migration images build; API/web/worker runtime images were started and probed. The host lacks the Docker Compose v2 plugin, so full Compose orchestration could not be executed here.
- Browser: all 7 Playwright journeys pass after removing an order-dependent mobile fixture and correcting primitive-array row keys.
- Dependency audit: zero known production dependency vulnerabilities on the review date.
- Local API smoke load: 2,000/2,000 successful; see `PERFORMANCE-REPORT.md`.
- Dependency outage smoke: readiness changed from 200 to 503 for both isolated Redis and PostgreSQL outages while the API process remained live.

## External dependencies and open gates

Required: managed PostgreSQL and Redis with TLS/private networking; secret/KMS service; TLS ingress/DNS; container registry; SMTP; production payment and payout adapters; AI provider; backup source, object storage and key manager; security-engine/CVE/malware providers as selected; centralized logs, metrics, tracing, errors and alerting; WAF/egress enforcement; and incident/on-call systems.

Before release, complete provider verification/reconciliation; staging backup/restore and remediation drills; retention/legal-hold implementation; production-scale mixed load and fault injection; RLS/audit immutability decisions; image/SBOM scanning and signing; security review of deployment manifests; data-processing/vendor review; and independent penetration testing.

## Required environment

Use `.env.example` as the exhaustive template. Production requires distinct secret-manager values for `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `AI_CREDENTIAL_ENCRYPTION_KEY`, `PAYMENT_CREDENTIAL_ENCRYPTION_KEY`, `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`, `REPORT_SIGNING_KEY`, and `METRICS_TOKEN`; TLS PostgreSQL/Redis URLs; exact HTTPS app/API/CORS origins; SMTP settings; and scanner limits. Provider credentials are write-only through approved Owner configuration paths where implemented.

## Deployment and rollback

Build immutable images, scan/sign them, run the migration image as a one-off job, deploy API/worker/web independently, gate traffic on readiness, and run authenticated smoke checks. Database migrations must be backward compatible with the previous application version. On application failure, route traffic to the previous signed image and stop new workers. Do not reverse a destructive migration blindly; restore through a reviewed forward migration or the tested managed-database recovery procedure. Preserve audit records and incident evidence throughout rollback.

## Operational recommendations

Set SLOs and paging, rotate keys/credentials, rehearse restore and rollback, monitor queue age/dead letters/provider error budgets, reconcile payments and payouts, periodically retest tenant isolation, schedule dependency/container scans, and review Owner/audit events. Release approval must be explicit after every open gate above has evidence.
