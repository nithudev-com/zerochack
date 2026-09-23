# Care workspace operations

## Rollout

1. Back up the PostgreSQL database and establish a tested restore point. Review the additive `20260923000000_chat_care` migration. It creates care records, scope constraints, a nullable legacy access reference, and a production-default environment for existing chat messages.
2. Keep `CARE_ENABLED=false` while applying `npm run db:migrate:deploy` and updating **all** API and worker instances. Existing binaries cannot decrypt a broker reference stored by this version. Do not enable capture in a mixed-version fleet.
3. Provision `CARE_VAULT_KEY` as a random base64-encoded 32-byte key in the deployment's secret manager. Production startup rejects a missing/default key or reuse of the existing AI, MFA, or integration encryption key. The application currently supports the `v1` key only; a multi-key rotation/re-encryption service is not implemented. Do not rotate the value while live ciphertext depends on it.
4. Enable `CARE_ENABLED=true` consistently on API and worker instances. Verify the maintenance worker runs. Before opening access to customers, run the real PostgreSQL integration suite and smoke-test capture, revoke, specialist MFA/grants, and SSE in staging.
5. In the existing owner AI gateway, add an Anthropic provider using `anthropic-messages`, an encrypted server-side API credential, and a model available to that account. Set the existing tenant/model rate, concurrency, and cost policy. Run a minimal approved live smoke test and record its actual usage. There is no automatic fallback to another provider after a policy refusal.

The web application exposes the new chat layout while care capabilities are opt-in. If disabled, ordinary existing assistant messages remain available and the workspace points to existing Secure Access. Repair requests never start a patch, preview, or release in this version.

## Capture format and boundaries

Use Secure capture inside the website conversation, choose Production or Staging, and confirm authority. Submit labelled fields, for example:

```text
Type: SSH
Host: server.example.com
Port: 22
Username: deployment
Password: <account password>
Fingerprint: SHA256:<trusted host fingerprint from the hosting provider>
```

Never copy this example placeholder as an actual credential. Use a line containing `---` between account blocks. JSON objects/arrays using `kind`, `host`, `port`, `username`, `secret`, and `authMethod` are also supported. A private key must parse as an actual SSH private key. Encrypted private keys needing a passphrase are not supported by this intake format. Unknown fields, mixed free-form instructions, duplicate fields, malformed keys, and batches above ten accounts are rejected without storing the submitted text. One SSH account per environment can be submitted at a time. Non-SSH storage does not enable its connector.

Input exists briefly in browser memory and in the authenticated request so it can be parsed and encrypted. It is excluded from ordinary message persistence, mutation-result caches, AI input, care events, and audit metadata. The ordinary-message detector is defense in depth and cannot reliably recognize every arbitrary unlabelled secret. Always select Secure capture when handling access information. Review proxy/error-tracking/session-replay configuration separately; application redaction cannot control third-party telemetry outside this process.

Inspection authorization expires after 24 hours. The broker rejects expired/revoked authority immediately; the worker removes expired ciphertext in batches every minute. Rotation is performed by submitting a replacement account, which creates a new identity and invalidates old grants. Database backups may retain historical ciphertext until their separate retention period ends.

## Specialist workflow

The specialist opens Approved Access, chooses an active assigned ticket and account, and states a reason and duration. The customer approves/denies the database-backed request in that website/environment conversation. The specialist enrolls an authenticator in Profile if necessary, verifies the six-digit code in Approved Access, then reveals the approved value. The endpoint rechecks assignment, account identity/version, expiry, credential authority, account MFA, and recent session MFA on every retrieval.

Audit action `care.credential_disclosed` means the server returned a secret. It does not prove the user copied it or used it externally. Browser hiding, revocation, or expiry cannot erase previous clipboard copies, screenshots, or password-manager entries. Use a managed specialist workstation and rotate external credentials after a disclosure when the task is complete. Managed-workstation enforcement and external rotation tracking are not implemented in this branch.

## Pause, stop, and recovery

Pause/cancel controls stop subsequent model steps once the tracked runner observes the state change. An already-started read-only observation can finish. These controls do not undo a remote action. Worker heartbeat loss becomes STALE after 90 seconds, including the snapshot projection when the maintenance worker is unavailable. Stale jobs are not automatically replayed; examine persisted results and authorization before starting a new request.

Disabling `CARE_ENABLED` stops conversational capture/disclosure and future broker reads of care credentials. It does not revoke external copies, terminate an already-open connection, or disable the application's separate legacy access/monitoring features. Use the existing operation-specific controls for those features. Credential revocation wipes the active envelope, revokes grants, and deletes the legacy broker reference.

For rollback, first stop new care work and disable the flag. Retain the additive schema and run a compatible binary until care vault references have been revoked or explicitly migrated. Do not simply deploy an old API against rows with an empty legacy `encryptedSecret` and a vault reference. A production rollback/restore drill is still required; no down migration or successful recovery exercise is claimed.

## Local verification

Use a disposable database whose name includes `test`; never point the integration tests at production. Apply all migrations and run:

```sh
npm ci
npm run db:migrate:deploy
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run openapi:generate
npm run test:e2e
npm run test:e2e:care
```

CI provisions PostgreSQL 16 and Redis and includes the new care browser suite. Fixture browser tests and mock SDK streams are deliberately labelled in the implementation record. Live provider and infrastructure readiness require separate measured evidence.
