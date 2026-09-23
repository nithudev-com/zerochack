# Specialist operations and remediation

## Lifecycle

Tickets move through `CREATED`, `QUEUED`, `ASSIGNED`, `ACCEPTED`, `AWAITING_AUTHORIZATION`, `AUTHORIZED`, `BACKUP_PENDING`, `READY`, `IN_PROGRESS`, `AWAITING_CUSTOMER`, `POST_SCAN`, `RESOLVED`, `CLOSED`, `ESCALATED`, or `CANCELLED`. API transitions use conditional database updates. Acceptance changes exactly one queued or validly assigned row, preventing double acceptance. Expired assignments are requeued before queue reads and accept attempts.

Specialists see only the seven operational sections required by Phase 5: Overview, Available Jobs, My Tickets, Active Sessions, Performance, Notifications, and Profile. Performance values are database counts of accepted, resolved, and escalated tickets. Salary and payroll data do not exist.

## Fail-closed remediation gate

A customer authorization records the session-derived tenant, website, ticket, authorizing user, explicit scope, timestamp, and expiry. New authorization revokes the prior grant. The API independently rechecks every binding and expiry before requesting a backup, creating a session, or executing a playbook.

A remediation backup is a distinct restore point bound to the ticket. The backup worker requires a configured `BackupProvider` to create and verify it. Without a provider, or when verification fails, the backup is marked failed, the ticket moves to `AWAITING_CUSTOMER`, and remediation stops. The repository does not pretend a backup exists.

Secure remediation sessions return a random temporary token once and store only its keyed hash. Sessions are specialist-, tenant-, website-, ticket-, authorization-, scope-, and expiry-bound. Replacement, manual revocation, expiry, and completed playbooks revoke access. No long-lived website credential is exposed.

## Playbooks and post-scan

Owners with recent MFA may register versioned playbooks, but the API accepts only explicitly compiled action keys. Phase 5 supports `FINDING_MARK_IN_REMEDIATION`; there is no shell or unrestricted command endpoint. Execution requires the temporary token and the complete authorization/backup/session gate, records an audit event, revokes the session, and queues a post-scan.

After the post-scan succeeds, the API calculates persisted before/after open-finding counts, stores the comparison on the remediation run, creates the comparison report record, and resolves the ticket. Warranty configuration is tenant-specific with duration, eligible severities, exclusions, enablement, and persisted claims.

## External requirement

A real `BackupProvider` implementation and its temporary-access revocation hook must be configured before protected production remediation can reach `READY`. The default worker deliberately fails closed with `BACKUP_PROVIDER_UNCONFIGURED`.
