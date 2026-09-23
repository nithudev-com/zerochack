# Owner control center

Phase 10 exposes a server-authorized Owner workspace at `/owner`. Its navigation contains the 25 operational sections specified for the platform. Every Owner control API requires an authenticated Owner role, the granular permission assigned to that operation, and an MFA-verified session.

## Administrative capabilities

- Users can be searched, filtered, inspected, approved, rejected, suspended, deactivated, reactivated where the account lifecycle permits it, and have all sessions revoked.
- Specialists are listed with current ticket workload. Ticket transfer and escalation use the existing audited ticket lifecycle and assignment rules; salary and payroll data do not exist.
- Packages, pricing, subscriptions, quotes, revenue, affiliate programs, commissions, payouts, backups, monitoring, and security events are read from their authoritative tables. Existing domain APIs remain responsible for validated mutations.
- Audit logs support bounded search/filter queries, individual inspection, and redacted CSV export.
- Permitted operational settings are stored in `system_settings`. The API uses an explicit allowlist, validates each value, and rejects rows marked as security invariants.
- Integration records expose configuration and health but never return encrypted credentials. Credential updates are encrypted with AES-256-GCM before persistence and are audited without credential values.

## Real system health

`GET /v1/owner/control/system-health` performs or reads real checks for the API, PostgreSQL, Redis, workers, BullMQ queues, scheduler registrations, SMTP, payments, AI providers, implemented security engines, storage, and WebSockets. Status is one of `HEALTHY`, `DEGRADED`, `FAILED`, or `NOT_CONFIGURED`; unavailable dependencies are never presented as healthy.

Workers publish an expiring Redis heartbeat. Queue health comes from current BullMQ counts, while scheduler health comes from registered repeatable jobs. Provider-backed systems combine stored enablement/health state with direct checks where a safe check exists.

## Sensitive actions

Administrative mutations call the same MFA-aware Owner guard used by approval and commercial controls. User lifecycle changes, session revocation, ticket transfer/escalation, setting changes, and integration configuration changes create audit events with request and actor context. API responses and exports recursively redact secret-like metadata keys.

Credential encryption currently uses the validated server-side payment credential envelope key. Production deployments should replace environment-held root encryption keys with an external KMS or secret manager, as described in [Security](SECURITY.md).

## Persistence

- `platform_integrations` stores adapter identity, non-secret configuration, encrypted credentials, enabled state, and observed health.
- `system_settings` stores validated operational values and records whether a setting is an immutable security invariant.
- Historical and authoritative domain records remain in their existing tables; the control center does not duplicate or fabricate metrics.

The migration is `20260903100000_owner_control_center`.
