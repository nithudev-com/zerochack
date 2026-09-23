# Backup, monitoring, and threat operations

## Backup execution

Manual, scheduled, and pre-remediation requests create a `QUEUED` database record before BullMQ receives work. Queue submission failure changes the record to `FAILED`; it is never left looking successful. The backup worker requires a configured `BackupProvider`, calls the provider, reads the artifact back for verification, and only then records `SUCCEEDED` and `verified_at`.

`@zerochack/storage` provides the provider-neutral contract and `EncryptedBackupProvider`. The encrypted provider obtains plaintext from a scoped `BackupSource`, obtains a tenant key from `BackupKeyManager`, encrypts with AES-256-GCM before calling `ObjectStorage.put`, and binds the ciphertext to tenant, website, and backup IDs through authenticated additional data. Only key IDs and encryption metadata are persisted. Key bytes remain in the backend key manager and never enter an API response.

Object storage is provider-neutral and can be implemented for S3-compatible or cloud storage. No production storage/source/KMS adapter is bundled, so the default worker fails with `BACKUP_PROVIDER_UNCONFIGURED` instead of claiming success.

## Restore and retention

Restore is a two-step flow: an authenticated tenant member creates a ten-minute authorization for a verified backup, then consumes it once to queue a restore. The worker rechecks tenant, website, backup, authorization time, artifact integrity, and provider confirmation. Restore failures are persisted and audited.

Backup policies define frequency, retention days, and restore-point limit. BullMQ schedules are reconstructed from PostgreSQL when the worker starts. Retention deletion happens only after provider deletion succeeds. Backups are protected while minimum retention applies or while referenced by remediation runs, active remediation tickets, active warranty claims, or an explicit protection date.

## Continuous monitoring

Monitoring defaults to 60 minutes. Owner policies can change interval, cooldown, expected status, required supported security headers, and an expected content hash. The worker uses the scanner's SSRF-safe, DNS-revalidated HTTP transport. It records availability, HTTPS/TLS reachability, selected public DNS address, security-header presence, and a response-content integrity hash. Response bodies, cookies, and header values are not persisted.

Changes become immutable integrity-hashed evidence, a security event, a severity-aware deduplicated alert, a tenant notification, and—for high or critical events—a queued specialist ticket. Repeat alerts inside cooldown increment `suppressed_count` without creating more notifications or tickets.

## Developer Mode

Developer Mode is tenant-scoped, time-limited, permission-controlled, and audited on configuration and diagnostic access. It exposes request IDs, database record IDs, job IDs, engine counts, timings, error codes, and worker states. It never returns tokens, credentials, encryption keys, backup contents, HTTP bodies, or provider secrets.

## Operational endpoints

- Customer operations: `/v1/websites/:websiteId/operations`, manual monitoring, backups, restore authorization, restore, and deletion.
- Developer Mode: `/v1/developer-mode` and `/v1/websites/:websiteId/diagnostics`.
- Owner policy management: `/v1/owner/operations/websites/:websiteId/monitoring-policy` and `backup-policy`.
- Alert handling: `/v1/operations/alerts/:alertId`.

All customer lookups combine resource IDs with the authenticated session tenant.
