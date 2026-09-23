# Care workspace operations

## Rollout

1. Back up the PostgreSQL database and establish a tested restore point. Review the additive `20260923000000_chat_care` and `20260923010000_care_repair` migrations. It creates care records, scope constraints, a nullable legacy access reference, and a production-default environment for existing chat messages.
2. Keep `CARE_ENABLED=false` while applying `npm run db:migrate:deploy` and updating **all** API and worker instances. Existing binaries cannot decrypt a broker reference stored by this version. Do not enable capture in a mixed-version fleet.
3. Provision `CARE_VAULT_KEY` as a random base64-encoded 32-byte key in the deployment's secret manager. Production startup rejects a missing/default key or reuse of the existing AI, MFA, or integration encryption key. The application currently supports the `v1` key only; a multi-key rotation/re-encryption service is not implemented. Do not rotate the value while live ciphertext depends on it.
4. Enable `CARE_ENABLED=true` consistently on API and worker instances. Verify the maintenance worker runs. Before opening access to customers, run the real PostgreSQL integration suite and smoke-test capture, revoke, specialist MFA/grants, and SSE in staging.
5. In the existing owner AI gateway, add an Anthropic provider using `anthropic-messages`, an encrypted server-side API credential, and a model available to that account. Set the existing tenant/model rate, concurrency, and cost policy. Run a minimal approved live smoke test and record its actual usage. There is no automatic fallback to another provider after a policy refusal.

The web application exposes the new chat layout while care capabilities are opt-in. If disabled, ordinary existing assistant messages remain available and the workspace points to existing Secure Access. Repair and release have separate default-off flags; enabling care alone does not start a repair or release.

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

## Static HTML repair rollout

Set CARE_REPAIR_ENABLED=true on all API/worker instances only after migrations and scoped integration checks pass. Provision CARE_ARTIFACT_KEY as a distinct random 32-byte base64 key. The production loader rejects missing/default/reused artifact keys. CARE_JOB_BUDGET_MICROS defaults to 500000 ($0.50 model allowance). Configure nonzero input/output model prices and a tenant policy before approval. The reservation is conservative, not a provider invoice guarantee; unknown provider charges remain held for reconciliation. Never silently reset a reservation whose invocation may have incurred charges.

The repair worker polls durable database jobs every two seconds, allows one running repair per website, uses a two-minute model cancellation deadline and a 90-second lease heartbeat threshold, and does not replay stale work. It supports only standalone HTML and inline CSS. It does not provision an engineering container or execute source. Do not enable broader role/tool catalogue entries to bypass this boundary.

Artifacts expire after seven days. The maintenance worker wipes expired ciphertext when no active or unresolved website release requires recovery material. Retained ciphertext does not extend expired authorization or make an expired artifact available through the API. Operator intervention may be necessary after expiry. Database backups retain ciphertext according to the database policy. Artifact-key rotation/re-encryption is not yet implemented; retain the key while any live or recovery artifact depends on it.

## Single-file production release

Keep CARE_RELEASE_ENABLED=false until real PostgreSQL/Redis CI, a disposable live-provider call, and a disposable SFTP/HTTP publish-and-restore drill pass. Release requires both other care flags. Use a minimally privileged deployment account, an independently verified host fingerprint, and an exclusively controlled web-root path. Do not use this path for JavaScript applications, forms, dynamic templates, cache-transformed pages, databases or multi-file deployments.

The customer reviews previews, selects the exact account and absolute index.html path, and confirms production replacement plus conditional rollback. MFA enrollment is available in customer Profile; a six-digit step-up enables the release approval for five minutes. The approval itself expires after 15 minutes. Source, candidate, account version, current membership/permissions, website lifecycle and public URL are rechecked by the worker. Read-only inspection consent alone never authorizes replacement.

The worker requires the exact source hash both in the SFTP target and the HTTP response before any mutation. It saves an encrypted original, verifies that copy, creates an exclusive sibling lock, stages a bounded temporary file and uses the OpenSSH atomic rename extension. There is no delete-and-rename fallback. A remote administrator must exclude out-of-band writes throughout this window; SFTP does not supply an atomic conditional compare-and-swap against them.

A verified candidate returns COMPLETED. A failed candidate health check with verified restoration returns ROLLED_BACK. A timeout, lost heartbeat or unverifiable mutation returns OUTCOME_UNKNOWN and blocks another release. Wait at least two minutes after last worker activity, verify identity and use Reconcile release outcome. This reads current remote/public hashes and never replays a write. When the baseline is observed after an uncertain result, BASELINE_CONFIRMED records that observation without claiming a rollback actually ran. Explicitly approved recovery may finish after the start-approval expiry, but current actor and credential authority are still required immediately before its write. If evidence disagrees, a trusted human must inspect the target and recovery evidence. Do not delete the lock or mark success merely to unblock another release. Remote temporary files can remain after a failed upload; investigate their exact release identity before manual cleanup.

Cancel pending release revokes an unstarted queued approval atomically. Once execution starts, do not change the scope during an active/unresolved release. Stop new releases with the flag and let an in-flight deterministic operation reach an observed outcome; disabling a flag does not terminate an already-open connection. Artifact removal is blocked while recovery may be necessary. A full database/server recovery plan remains separate from this single-file rollback.
