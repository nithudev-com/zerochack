# RBAC and tenant isolation

Authorization is evaluated by the API from a hashed, unexpired, unrevoked session. Client-supplied role or tenant headers are never authoritative. A session binds one user to one tenant; assignments in `user_roles` are also tenant-bound.

## Least-privilege matrix

| Permission | Customer | Agency | Affiliate | Cybersecurity Specialist | Owner |
|---|:---:|:---:|:---:|:---:|:---:|
| `profile.read`, `profile.update` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `sessions.read`, `sessions.revoke` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tickets.create` | ✓ | ✓ | — | — | ✓ |
| `tickets.read` | ✓ | ✓* | — | ✓* | ✓ |
| `tickets.assign` | — | ✓* | — | ✓* | ✓ |
| `tickets.remediate` | — | — | — | ✓* | ✓ |
| `billing.read` | ✓ | ✓* | ✓ | — | ✓ |
| `billing.manage` | — | — | — | — | ✓ |
| `users.read` | — | ✓* | — | — | ✓ |
| `users.approve`, `users.suspend` | — | — | — | — | ✓ |
| `referrals.read`, `referrals.create` | — | — | ✓ | — | ✓ |
| `ai.use` | ✓ | ✓ | ✓† | ✓ | ✓ |
| `ai.security_context` | ✓ | ✓* | — | ✓* | ✓ |
| `ai.providers.manage`, `ai.usage.read` | — | — | — | — | ✓ |
| `specialist.jobs.read`, `specialist.jobs.accept` | — | — | — | ✓ | ✓ |
| `remediation.authorize` | ✓ | — | — | — | ✓ |
| `remediation.execute` | — | — | — | ✓ | ✓ |
| `remediation.manage`, `warranty.manage` | — | — | — | — | ✓ |
| `system.health.read` | — | — | — | — | ✓ |
| `integrations.manage`, `settings.manage` | — | — | — | — | ✓ |
| `notifications.manage` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `email.templates.manage` | — | — | — | — | ✓ |
| `audit.read`, `roles.manage`, `tenants.manage` | — | — | — | — | ✓ |

`*` remains constrained to the current tenant or an explicit active agency-client relationship. Permission possession never removes tenant filtering.

`†` Affiliate access is general-purpose only. Both RBAC and the gateway role policy prohibit website, finding, scan, evidence, ticket, or other security context.

## Account lifecycle

- Customer: `REGISTERED → APPROVED` after email verification.
- Agency, Affiliate, Specialist: `REGISTERED → PENDING_APPROVAL` after verification, then an MFA-authenticated Owner chooses `APPROVED` or `REJECTED`.
- An Owner may set non-Owner accounts to `SUSPENDED` or `DEACTIVATED`; either transition revokes every active session.
- Owner accounts are created only with the local provisioning command and cannot be registered or assigned through public APIs.

## Tenant isolation

Every session, membership, and role assignment contains `tenant_id`. Protected handlers derive it from the session. Direct cross-tenant access returns `404` to avoid confirming resource existence. Agency access requires an `ACTIVE` row in `agency_client_relationships`; altered UUIDs, query values, and headers do not create a grant.

Agency relationships also carry per-client capabilities. Both the Agency role permission and the corresponding relationship capability must pass; either one alone is insufficient. See [Agency platform](AGENCY-PLATFORM.md).

Affiliate accounts can read only their own profile ledger. Program configuration, commission approval, and payout transitions require the Owner role, `affiliate.manage`, and recent Owner MFA.

Authenticated responses are `private, no-store`. Future WebSocket handshakes must call the same authentication and tenant policy before upgrade; no WebSocket endpoint is exposed in Phase 1. Tests cover HTTP path/header manipulation plus the shared policy used for future WebSocket and cache keys.

## Owner and step-up controls

Owner password validation creates only a five-minute, single-use MFA challenge—not a session. First access enrolls TOTP. Subsequent access requires TOTP or a one-use recovery code. TOTP secrets are AES-256-GCM encrypted, recovery codes are HMAC-hashed, and successful MFA is recorded on the session. Sensitive Owner routes require the Owner role, granular permission, and MFA-verified session.

The control center additionally separates health inspection, integration management, settings management, user administration, commercial management, and audit inspection by permission. Ordinary settings cannot disable records marked as security invariants. See [Owner control center](OWNER-CONTROL-CENTER.md).
