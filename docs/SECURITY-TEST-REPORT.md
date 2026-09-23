# Phase 12 security test report

Date: 2026-09-03. Scope: source review plus local unit, API-injection, PostgreSQL/Redis integration, browser, packaging, dependency, and load checks. This is an engineering review, not an independent penetration test.

## Results

| Area | Evidence | Result |
|---|---|---|
| Authentication and sessions | Argon2id, opaque token hashes, expiry/revocation, account lock, reset replay tests | Pass |
| Owner MFA and RBAC | TOTP/recovery tests, role-specific login checks, server permission checks | Pass |
| Tenant isolation | Two-tenant website, chat stream, finding, scan, evidence, ticket, alert, backup, notification, report, agency, and AI denial attempts | Pass in tested paths |
| Remediation gate | Unit and integration checks for tenant, website, ticket, authorization, verified backup, specialist, scope, session expiry/revocation | Pass; runtime provider absent |
| SSRF | Private/reserved IPv4 and IPv6, alternate IPv4 notation, internal/mixed DNS, redirect, downgrade, protocol and port tests | Pass in application layer |
| AI | Role/tenant policy, redaction, malicious untrusted context, disabled credentials, provider failure, quotas and idempotency | Pass with injected adapter; no live provider test |
| Payments | Signature rejection, freshness, replay, duplicate event, conflicting duplicate payload, duplicate payment and concurrent refund reservation | Pass with injected adapter; no live provider reconciliation |
| Backups | Tenant-bound AES-256-GCM, tamper detection, authorization, failure behavior and retention limits | Pass with test adapter; no staging restore drill |
| Communications/reports | recipient scoping, event idempotency, email retry, canonical report signature and cross-tenant denial | Pass |
| Dependency audit | `npm audit --omit=dev` | 0 known vulnerabilities on review date |
| Secrets/source scan | tracked-style source scan and prohibited-marker review | No production credential found |
| Database/Redis outage | Stopped each isolated dependency and probed readiness | API stayed live and readiness returned 503 |

## Vulnerabilities resolved

- Restricted specialist alert mutation to the authenticated tenant; only Owner retains global scope.
- Restricted unread counts to the authenticated recipient or intentional tenant broadcasts.
- Revalidated session, account, and membership state during long-lived chat streams.
- Prevented login/session issuance through inactive tenant memberships and bound Owner MFA challenges to the active tenant assignment.
- Added route-specific MFA attempt limits and permission checks to specialist transfer, escalation, session, post-scan, and warranty operations.
- Rejected client-selected request IDs, unsafe cross-site state changes, insecure production transports, and placeholder secrets.
- Added production CSP/HSTS and no-store responses.
- Blocked IPv6 bracket bypasses, non-global IPv6 destinations, alternate IPv4 forms, unsafe protocols/ports, and HTTPS-to-HTTP scan redirects.
- Rejected reused provider webhook IDs whose payload hash differs.
- Serialized refund capacity reservation to prevent concurrent over-refunds and allowed valid subsequent partial refunds.
- Replaced fabricated scanner health with status derived from persisted scan outcomes.
- Separated general integration encryption from the payment credential key.

## Open security and release risks

| Severity | Risk | Required disposition |
|---|---|---|
| Critical release blocker | Worker has no production backup source/object-storage provider/key-management integration; remediation therefore fails closed | Install approved providers and pass backup/restore and destructive staging drills |
| High | No PostgreSQL row-level-security policy or restricted append-only audit writer | Add after connection-pooling design; retain application predicates |
| High | No production payout adapter verifies a payout before a record may become `PAID` | Add provider-confirmed payout settlement and reconciliation |
| High operational | Retention workers/policies are absent for evidence, reports, notifications, monitoring events, audit records, and application logs | Define legal periods and implement/test purge and legal-hold behavior |
| High operational | No deployed tracing, error monitor, centralized log store, dashboards, or paging | Select providers, configure SLOs and exercise alerts |
| Medium | Scanner egress policy is an example, not a deployed control | Adapt and enforce network policy/firewall in the target platform |
| Medium | Database/Redis/queue/provider outage testing is partial and local | Run controlled staging fault injection with real managed services |
| Medium | No independent penetration test or external audit | Complete before internet-facing launch |

## No-dummy-feature review

The repository-wide search found no application `TODO`, `FIXME`, `console.log`, dummy success, or fake provider success path. Remaining `mock` occurrences are test doubles; `placeholder` occurrences are HTML/email-template terminology; the threat model intentionally records an unimplemented database append-only control. External provider gaps are documented and fail closed.
