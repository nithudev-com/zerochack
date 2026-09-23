# Notifications, email automation, and reporting

Phase 11 uses a durable, recipient-scoped communication outbox. Domain actions create a `communication_events` row with a stable deduplication key and enqueue its identifier. The notification worker applies the recipient's channel preferences, creates at most one in-app notification and one email delivery, then queues delivery. Event payloads contain display-safe context only; authentication verification and reset tokens continue through the dedicated authentication mail path and are never stored in the generic event payload.

Supported event types are registration, email verification, approval, suspension, scan start/completion, critical findings, monitoring alerts, backup success/failure, tickets, specialist assignment, authorization requests, remediation start/completion, post-scans, warranty, subscriptions, payments, invoices, affiliate commissions, and payouts.

## Delivery guarantees

- Communication deduplication keys, notification event IDs, email event IDs, and email idempotency keys are database-unique.
- BullMQ uses deterministic job IDs, five attempts, and exponential backoff.
- Delivery attempts, next retry time, provider message ID, terminal status, and safe error code are persisted and audited.
- SMTP messages use a deterministic `Message-ID` derived from the delivery idempotency key. This gives supporting providers a stable duplicate-suppression identity.
- Preferences are scoped to tenant, user, and event type. Missing preferences default to both in-app and email enabled.

SMTP is an at-least-once external boundary: a provider could accept a message and disconnect before acknowledgement. Deterministic message identity and the durable claim minimize duplicates, but production providers should support idempotent submission where available.

## Template safety and administration

Templates are immutable versions keyed by event type. Publishing an enabled version atomically disables the prior enabled version. Owners with recent MFA and `email.templates.manage` can publish, preview, enable/disable, inspect delivery status, and test-send.

Rendering supports scalar `{{placeholder}}` substitution only. There is no expression evaluator, code execution, file loading, URL loading, or template scripting. Malformed braces, script tags, `${...}`, and executable-template syntax are rejected.

## Reports

The reports worker generates authoritative JSON documents for:

- security scans and normalized findings/evidence;
- remediation runs and approved actions;
- monitoring checks and security events;
- remediation before/after comparisons.

Every report is bound to a tenant and website. The worker re-queries its source using both identifiers, stores only selected non-secret fields, computes a SHA-256 integrity hash, and signs canonical JSON with HMAC-SHA-256 using the independent `REPORT_SIGNING_KEY`. PostgreSQL JSON key reordering does not invalidate signatures because canonicalization recursively sorts object keys.

Downloads require an authenticated session, `reports.read`, the current tenant, the matching website, a completed report, and successful integrity/signature verification. Cross-tenant and altered report/website identifiers return `404`. Successful downloads are audited and include integrity and signature response headers.

## Operational dependencies

PostgreSQL stores outbox, preference, template, delivery, and report state. Redis/BullMQ runs `notifications`, `email`, and `reports` queues. SMTP performs real delivery. If a queue or source is unavailable, the operation records failure rather than reporting success.
