# Backup and restore runbook

Backups are queued, tenant/website/ticket bound, encrypted with AES-256-GCM before object storage, authenticated with tenant-bound AAD, hashed, and verified before success. Restore requires a single-use, expiring authorization and re-verifies ciphertext before invoking the source connector.

Pre-remediation flow is authorization → backup creation → cryptographic verification → temporary session. A failed or unconfigured provider marks the backup failed and prevents remediation.

Operational restore procedure:

1. Confirm tenant, website, restore point, retention and incident scope.
2. Create a short-lived restore authorization through the API.
3. Submit the restore once and retain its request ID.
4. Monitor the backup queue and `restore_operations` record.
5. Verify the restored application independently before closing the incident.

This repository contains the provider-neutral encrypted implementation but no production `BackupSource`, key manager, or object-storage adapter. Until those are installed and a destructive restore drill passes in staging, backup/restore and remediation are release blockers.
