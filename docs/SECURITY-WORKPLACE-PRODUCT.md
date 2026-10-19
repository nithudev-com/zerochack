# Managed staging security repair product

This increment connects the existing security conversation, authenticated product
API, encrypted PostgreSQL journal/checkpoints, BullMQ worker and fixed-command
managed target. It preserves the existing website inspection, history, secure
capture and other workplaces. It does not register a production executor or turn
static permission hardening into WordPress/malware cleanup.

## Exact usable slice

The single supported adapter is `MANAGED_STATIC_PERMISSION_V1`, in **STAGING**.
It operates on the one fresh, operator-provisioned root-owned static file described
in the [managed target contract](../infrastructure/security-managed-target/README.md).
HARDEN removes only the other-write permission bit; bytes and identity stay intact.
RESTORE creates a new run over an earlier completed HARDEN result and requires two
new exact approvals. It never blindly restores an uncertain operation.

The customer manually opens Managed staging repair in the security chat. The
server lists only their current enrolled target, then derives the actor, session,
tenant, website, credential version, current entitlement, budget and implementation
identity. No chat/model/browser-supplied path, shell, executor, key or proof flag
is accepted. Existing source/model gateways are preserved; this deterministic
permission operation does not need or fabricate a model call.

1. Admit the exact staging target after fresh MFA and scoped authorization.
2. Read the observed plan and approve that immutable plan receipt.
3. Prepare and independently decrypt/hash-verify encrypted recovery; retain its
   envelope and metadata in encrypted CareArtifact evidence.
4. Verify the candidate and show the exact preimage/mode difference.
5. Approve that exact change receipt separately. Current approvals, lease,
   session, entitlement, credential and enrollment are rechecked before signing.
6. Send one bounded forced-command mutation permit, verify the actual result and
   persist independent post-verification evidence before completion.

Cancellation fences future work; it does not promise remote undo. Lost write
acknowledgements remain `OUTCOME_UNKNOWN`, retain the website slot and cannot be
automatically replayed. A failed/expired/revoked approval never becomes a successful
repair. The worker dispatches both exact approvals, with one execution attempt and
global concurrency one. Redis payloads contain identifiers only.

## API

All paths are under `/v1/websites/:websiteId/security-repair` and require the
existing signed-in session and current tenant membership.

| Method/path | Behavior |
|---|---|
| GET `capabilities`, `enrollment` | Safe enrolled-target metadata and explicit blockers |
| GET/POST `runs` | Saved history or server-derived admission with an idempotency key |
| GET `runs/:runId` | Safe immutable plan/proposal/result receipts and saved progress |
| POST `runs/:runId/candidate-decisions` | Exact plan approval/denial |
| POST `runs/:runId/change-decisions` | Separate exact staging change approval/denial |
| POST `runs/:runId/cancel` | Persist a stop fence; uncertain outcomes remain uncertain |

Only the original actor/session can operate a run. History survives session
changes; stale sessions do not inherit mutation authority. Mutations require recent
MFA and an actual paid subscription whose immutable feature entitlements explicitly
include `securityManagedStagingPermissionRepair`. Trials, refunded payments and
unrelated subscriptions do not grant this capability. Existing one-time security
fix orders and other commercial flows are unchanged.

## Operator enrollment and deployment

The product defaults off. Source includes the startup/worker integration; a flag
alone is insufficient. Provision and independently verify the actual managed
filesystem, publisher isolation, forced command, pinned SSH identity, separate
permit/recovery keys and recovery drill before creating an enrollment.

The operator registry schema is exported from `operator-registry.ts`. Its file is
`/etc/codebandage/security-repair/enrollments.json`, with version 1 and entries
containing `enrollment`, `attestationFile`, `permitKeyFile`, `recoveryKeyFile`.
The enrollment is the strict `securityEnrollmentSchema`; the independently retained
attestation uses `securityOperatorAttestationSchema`. It binds exact account,
site/actor, namespace/target, credential version, forced command, host identity,
proof and reviewed implementation. Its raw byte SHA-256 must match the enrollment.
The pinned `SECURITY_REPAIR_IMPLEMENTATION_DIGEST` must match both records.

The loader reloads and validates authoritative files for each operation. It refuses
symlinks, nonregular/shared-link files, writable/non-root owners, path escape,
untrusted ancestors, changed identities, duplicate targets and mismatched proofs.
Signing and AES recovery keys are distinct 32-byte raw files. They must be private
root-owned 0400, or explicitly dedicated service-group 0440 with protected matching
group directories. World-readable or executable keys are refused. Neither keys nor
operator paths enter the public API, model context or graph state.

The existing vault must contain the actor-authorized STAGING SSH_KEY credential
for the dedicated `codebandage-managed-target` forced-command account. The worker
decrypts it only for a bounded effect, pins the operator-verified SSH host and
zeroes owned key buffers afterward. The encrypted recovery key copy must match the
helper's independent AES key, never the signing/vault/artifact key.

Before opt-in, back up current data and keys and apply all additive migrations,
including `20261019000000_security_repair_product`. Existing rows remain valid and
non-mutating. Build/test the exact API and worker images together. The optional
`infrastructure/production/compose.security-repair.yml` mounts only the protected
operator directory read-only with `create_host_path:false`; it does not modify the
domain, Caddy, network topology or default deployment. Set CARE_ENABLED and distinct
vault/artifact keys, the explicit security flag, config path and reviewed digest.
Validate effective UID/GID and file access in the exact non-root images before
using that overlay. Do not publish private enrollment/key material in Git or logs.

## Runtime and release limits

The new fixed offline runtime broker has durable one-shot admission, scoped hashes,
strict profiles, bounded processes, receipt/status and uncertain-outcome handling.
It remains unavailable until actual gVisor guest/resource/network/crash proofs pass.
The official rootless systemd failure in ADR002 is not solved by removing cgroup
limits, installing an unreviewed runtime patch or selecting ordinary containers.

General malware quarantine, WordPress core/plugin repair, PHP/Node candidate
execution and the 24-incident benchmark remain unimplemented or blocked. Their
UI/plan flags are not fabricated successes. No new live customer repair or VPS
activation is certified by local protocol/browser tests.
