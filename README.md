# ZeroRoot

Production-oriented multi-tenant cybersecurity SaaS foundation and operational platform. Implemented workflows through Phase 10 use authoritative database/provider state and contain no fabricated users, scans, metrics, payments, or integrations.

## Stack

- Next.js 16, React 19, Tailwind CSS, TanStack Query, React Hook Form, and Zod
- Fastify REST API with OpenAPI, structured Pino logs, security headers, CORS, and rate limiting
- PostgreSQL 16 with Prisma; Redis 7 with BullMQ
- npm workspaces, TypeScript strict mode, ESLint, Vitest, Playwright, Docker Compose, and GitHub Actions

## Quick start

```bash
cp .env.example .env
npm install
docker compose -f infrastructure/docker/docker-compose.yml up postgres redis -d
npm run db:migrate
npm run dev
```

Web: `http://localhost:3000` · API: `http://localhost:4000/v1` · OpenAPI UI: `http://localhost:4000/docs` · Mailpit: `http://localhost:8025`

For the complete workflow see [Local development](docs/LOCAL-DEVELOPMENT.md). Architectural and operational decisions are in `docs/`.

## Workspace map

```text
apps/             web, API, and queue worker entrypoints
packages/         shared UI and domain/service boundaries
infrastructure/   local containers, load harness, and deployment/monitoring guidance
docs/             architecture, database, security, testing, and deployment guidance
```

SMTP email delivery has a Mailpit-backed local implementation. Notifications, payments, storage, and reports remain provider-neutral boundaries. The AI gateway includes an authorized server-side Responses adapter but no provider or credential is preconfigured. The scanner package implements two read-only HTTP engines. See [RBAC and tenant isolation](docs/RBAC.md).

See [Customer portal](docs/CUSTOMER-PORTAL.md) for the Phase 2 data model, API, chat transport, ownership verification, and isolation guarantees.

See [Website connection and scanning](docs/SCANNING.md) for the outbound security policy, implemented engines, worker lifecycle, and evidence contract.

See [Central AI Gateway](docs/AI-GATEWAY.md) for provider configuration, encryption, tenant policy, prompt isolation, limits, retries, and usage accounting.

See [Specialist remediation](docs/REMEDIATION.md) for ticket locking, customer authorization, verified restore points, temporary sessions, approved playbooks, post-scans, access revocation, and warranties.

See [Commercial platform](docs/COMMERCIAL.md) for immutable package versions, subscriptions, provider verification, invoices, refunds, webhooks, and quotes.

See [Backup, monitoring, and threat operations](docs/BACKUP-MONITORING.md) for encrypted provider storage, restore authorization, retention, scheduled monitoring, evidence, alert deduplication, and Developer Mode.

See [Agency platform](docs/AGENCY-PLATFORM.md) for explicit client grants, multi-website scoping, owner-controlled agency commerce, quote provenance, and revocation behavior.

See [Affiliate system](docs/AFFILIATE-SYSTEM.md) for secure attribution, configuration-versioned commissions, refund reversals, payout locking, and fraud controls.

See [Owner control center](docs/OWNER-CONTROL-CENTER.md) for MFA-gated administration, real dependency health, redacted audit export, operational settings, and encrypted integration configuration.

See [Notifications, email automation, and reporting](docs/COMMUNICATIONS-REPORTING.md) for the idempotent communication outbox, channel preferences, safe template versions, delivery retries, and signed tenant-scoped reports.

The current release verdict and remaining gates are in the [Phase 12 release report](docs/RELEASE-REPORT.md), with detailed [security](docs/SECURITY-TEST-REPORT.md) and [performance](docs/PERFORMANCE-REPORT.md) results. The project is not claimed production-ready while those gates remain open.
