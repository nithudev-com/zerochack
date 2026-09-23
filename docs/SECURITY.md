# Security

## Current controls

- Startup configuration rejects missing database, Redis, and session secrets. Production rejects placeholder secrets, non-TLS database/Redis transports, non-HTTPS origins, local SMTP defaults, and reused development encryption keys.
- HTTP security headers including production CSP/HSTS, strict origin allowlisting, Fetch Metadata checks, credential-aware CORS, one-megabyte body limits, no-store responses, and a rate-limit baseline are applied by the API.
- Every request gets an ID. Production responses hide internal failures and stack traces.
- Logger redaction covers passwords, authorization, cookies, tokens, API keys, secrets, private keys, and payment credentials.
- Session storage is designed for opaque token hashes, explicit expiry/revocation, tenant binding, and secure cookies.
- Password helpers use Argon2id-compatible defaults. Authorization and tenant assertions live in server-consumable packages.

## Phase 1 identity controls

Opaque session, verification, reset, and MFA challenge tokens use 256 bits of randomness and are stored only as keyed SHA-256 hashes. Verification/reset/challenge records expire and are atomically consumed once. Password reset revokes all sessions. Login is route-rate-limited and five failed attempts create a timed account lock.

Owner sessions cannot exist before TOTP or a recovery code succeeds. TOTP secrets use AES-256-GCM at rest, recovery codes are one-use hashes, and Owner administration checks role, granular permission, and MFA state. See `RBAC.md` for the matrix and tenant policy.

## Scanner SSRF boundary

Scanner requests use address-range denial, all-answer DNS validation, validated-address pinning, same-host redirect enforcement, standard-port allowlisting, response limits, timeouts, and worker isolation. See [Scanning](SCANNING.md). The deployment NetworkPolicy is a template that must be adapted and applied by the production platform; application checks remain mandatory defense in depth.

## AI boundary

AI credentials use a dedicated validated AES-256-GCM key and exist only in encrypted database fields and backend memory during a request. Server-side role checks, tenant-scoped context queries, secret redaction, untrusted-data delimiters, no model tools, idempotency, cost ceilings, and Redis rate/concurrency limits apply before provider access. Provider responses cannot change finding severity, evidence, status, or another authoritative record. See [Central AI Gateway](AI-GATEWAY.md).

## Remediation boundary

Remediation requires matching tenant, website, ticket, specialist, scoped authorization, verified restore point, unexpired temporary session, and enabled compiled playbook. Temporary tokens are returned once and stored as keyed hashes. The API exposes no arbitrary command execution. Completion or failure revokes access, and every protected transition is auditable. See [Specialist remediation](REMEDIATION.md).

## Payment boundary

Payment credentials use a dedicated production-required encryption key. Webhooks require adapter signature verification over raw bytes, a five-minute replay window, unique provider event IDs, payload hashes, safe audit records, and idempotent processing. Checkout success is established only by provider verification. See [Commercial platform](COMMERCIAL.md).

## Backup and monitoring boundary

Backup plaintext is encrypted with AES-256-GCM before object storage, authenticated to tenant/website/backup scope, and verified by read-back. Restore requires a tenant-scoped, expiring, one-use authorization and worker-side revalidation. Monitoring reuses the SSRF-safe outbound transport and persists hashes and presence indicators rather than response bodies or secret-bearing values. Alerts use severity-aware cooldowns. Developer Mode is time-limited and explicitly excludes secrets. See [Backup and monitoring](BACKUP-MONITORING.md).

## Owner administration boundary

Owner control routes require a valid session, the Owner role, a granular permission, and completed MFA. Integration credentials are write-only at the API boundary and encrypted before persistence. Settings use a validated allowlist and cannot modify security-invariant records. Administrative mutations and session revocations are audited, while audit views and CSV exports recursively redact sensitive metadata. See [Owner control center](OWNER-CONTROL-CENTER.md).

## Communication and report boundary

Notifications are addressed to a tenant and recipient; all inbox and read mutations enforce both. Email templates allow substitutions but no expressions or executable syntax. Deliveries use unique event/idempotency keys, deterministic provider message identity, persisted retry state, and safe audit metadata. Reports re-query tenant-bound source records, omit secrets, use canonical SHA-256 integrity metadata, and carry an HMAC-SHA-256 signature from the independent production-required `REPORT_SIGNING_KEY`. Downloads verify authorization and signature before returning content. See [Communications and reporting](COMMUNICATIONS-REPORTING.md).

## Required before public production

Add an external secret manager, TLS at every network boundary, a synchronizer CSRF token if deployments ever require cross-site cookies, database RLS after pooling review, dependency/container scanning, SBOMs, signed artifacts, WAF rules, complete data retention, and an incident response process. API rate limits already use shared Redis outside tests. See [Phase 12 security test report](SECURITY-TEST-REPORT.md) for open release blockers.

Never accept a tenant ID from a client as proof of access. Derive it from a validated session and membership, then scope every server-side query. Audit records must not include secrets or unnecessarily sensitive payloads.

Report vulnerabilities privately to the repository owner; do not open a public issue containing exploit details.
