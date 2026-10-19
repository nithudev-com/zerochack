# Specialist operations and remediation

## Lifecycle

Tickets move through `CREATED`, `QUEUED`, `ASSIGNED`, `ACCEPTED`, `AWAITING_AUTHORIZATION`, `AUTHORIZED`, `BACKUP_PENDING`, `READY`, `IN_PROGRESS`, `AWAITING_CUSTOMER`, `POST_SCAN`, `RESOLVED`, `CLOSED`, `ESCALATED`, or `CANCELLED`. API transitions use conditional database updates. Acceptance changes exactly one queued or validly assigned row, preventing double acceptance. Expired assignments are requeued before queue reads and accept attempts.

Specialists see only the seven operational sections required by Phase 5: Overview, Available Jobs, My Tickets, Active Sessions, Performance, Notifications, and Profile. Performance values are database counts of accepted, resolved, and escalated tickets. Salary and payroll data do not exist.

## Fail-closed remediation gate

A customer authorization records the session-derived tenant, website, ticket, authorizing user, explicit scope, timestamp, and expiry. New authorization revokes the prior grant. The API independently rechecks every binding and expiry before requesting a backup, creating a session, or executing a playbook.

A remediation backup is a distinct restore point bound to the ticket. The backup worker requires a configured `BackupProvider` to create and verify it. Without a provider, or when verification fails, the backup is marked failed, the ticket moves to `AWAITING_CUSTOMER`, and remediation stops. The repository does not pretend a backup exists.

Secure remediation sessions return a random temporary token once and store only its keyed hash. Sessions are specialist-, tenant-, website-, ticket-, authorization-, scope-, and expiry-bound. Replacement, manual revocation, expiry, and completed playbooks revoke access. No long-lived website credential is exposed.

## Playbooks and post-scan

Owners with recent MFA may register versioned playbooks, but the API accepts only explicitly compiled action keys. The legacy `FINDING_MARK_IN_REMEDIATION` key only described a database label; it is not a website repair. After checking the temporary token and complete authorization/backup/session gate, the current route returns `REMEDIATION_EXECUTOR_UNAVAILABLE` **before** creating a run, changing a finding, revoking the session as completed, or queueing a post-fix scan. There is no shell or unrestricted command endpoint.

Post-scan completion requires actual verified mutation evidence. Historical status-only runs return `NO_VERIFIED_MUTATION` even if their scan succeeded; they are preserved, not converted into resolved tickets or successful repair reports. Warranty configuration/claims remain unchanged. New typed security repair capabilities require their own proven executor, exact authorization, recovery and independent verification; see [Security workplace capabilities](SECURITY-WORKPLACE-CAPABILITIES.md).

## External requirement

A real `BackupProvider` implementation and its temporary-access revocation hook must be configured before protected production remediation can reach `READY`. The default worker deliberately fails closed with `BACKUP_PROVIDER_UNCONFIGURED`.
