# Operations guide

## Safe failure behavior

- PostgreSQL or Redis readiness failure returns 503.
- Queue submission failure marks created work failed or disables scheduling.
- Worker jobs reload and validate tenant/resource bindings from PostgreSQL.
- SMTP failures retry and remain auditable.
- AI and payment provider failures return errors and never synthesize success.
- Missing backup storage fails backup and blocks remediation.

## Deployment

Apply migrations as a separate one-shot task, deploy API and workers, then deploy the web image. Verify readiness, worker heartbeat, queue failures, SMTP, provider health, scanner execution and metrics before shifting traffic.

## Rollback

1. Stop traffic to the new API and pause new queue producers.
2. Redeploy the previous immutable images; do not automatically reverse a database migration.
3. Keep compatible forward migrations in place whenever possible.
4. If schema rollback is unavoidable, restore a pre-deployment PostgreSQL snapshot into a new database and validate it before switching connections.
5. Resume workers only after confirming job-payload compatibility.
6. Record the rollback and reconcile payments, emails, backups and in-flight remediation jobs.

## Incident priorities

Revoke sessions and remediation tokens first for identity incidents. Disable an affected provider credential without rotating around provider limits. Preserve audit, payment webhook, scan evidence and queue failure records. Never delete a backup protected by active remediation or warranty work.
