# Security workplace operations — existing VPS

Use the existing trusted SSH/key connection; never reuse exposed chat passwords.
Production checkout `/opt/codebandage/source`, protected secrets/trust
`/opt/codebandage/state`, release manifests `/opt/codebandage/releases`, current
database backup directory `/opt/codebandage/backups`. Host Caddy terminates HTTPS;
application ports bind loopback and database/Redis stay on private TLS networks.
Keep `codebandage.com` routing/TLS/domain unchanged. No new cloud account/DNS needed.

## Current measured gates

Inventory18October2026:8CPU/about23.5GiBRAM, cgroupv2, rootdisk93%used then95%
after candidate images. Existing productionCPUcaps total7.5 and memorycaps8.25GiB;
these are not reserved headroom or load results. No runsc/rootless launch, cgroup
enforcement, disk quota or hostile-job network test has passed yet. Start no
untrusted job until measured capacity and all isolation gates pass.

Do not broadly prune images/volumes/containers to make room. Identify exact
disposable stopped test targets, retain required reports and rollback artifacts,
and obtain any necessary cleanup approval. Never remove production volumes,
keys, backups or other projects. Same-disk backups are not disaster recovery.

## Runtime provisioning gate

1. Review capacity and separate a dedicated unprivileged runtime/broker identity
   from control-plane and customer job users. Preserve the current recovery SSH
   session. Docker socket/group access is root-equivalent, not unprivileged.
2. Install reviewed pinned runsc/rootless prerequisites only through approved
   host provisioning. Do not restart/reconfigure the working production daemon.
   Validate AppArmor narrowly; do not disable it globally.
3. Demonstrate engine-managed user/network namespaces and cgroupv2/systemd
   delegation. Rootless flags that are ignored do not satisfy resource protection.
4. Pin reviewed local image/profile identities; never runtime-pull a floating tag.
   Run one isolated job with conservative caps, dedicated bounded storage and an
   outer timeout. Deny network before untrusted code starts; test DNS/IPv4/IPv6/
   private/metadata/control-plane destinations and engine-socket/mount access.
5. Test process storms, memory/CPU/storage limits, timeout/cancel/crash cleanup and
   live app readiness before/under/after the bounded load. Retain actual measurements.
6. Keep execution unavailable with exact reasons if any boundary fails. No ordinary
   container/process or external managed sandbox fallback is authorized.

## Activation and emergency stop

Implementation, configuration, enablement and live-verification are separate.
Keep new production actions unavailable until their exact slice passes. Existing
read-only connection/inspection continues independently. Preserve the specialist
`REMEDIATION_EXECUTOR_UNAVAILABLE`/`NO_VERIFIED_MUTATION` guards for all unregistered
operations. Existing Care review/static/browser/verification/release flags are not
security execution switches.

The future security controller must stop admissions, fence future steps and retain
in-flight uncertainty on emergency stop. Browser stop-generation is not cancel-job.
Never replay possible writes or paid calls after restart; consult the journal and
reconcile read-only. A cancellation cannot undo an already-sent operation.

## Recovery and release

Before mutation verify encrypted original bytes AND metadata readback, exact
account/target/preimage and a disposable resource-appropriate restore drill.
Forensic preservation and clean restoration are different. Recovery requires its
own valid exact authority/current-state match; never overwrite later customer work.
Never regenerate existing vault/artifact keys against encrypted data. Preserve
keys with encrypted off-server backups through separately approved storage.

Deploy only exact tested source/image identities with reviewed additive migrations,
fresh encrypted database backup, zero conflicting work, canary readiness and saved
previous manifests/Caddy configuration. Validate and reload Caddy safely; preserve
certificate storage. No automatic live database downgrade/restore after writes.
Do not open customer release based on a Git push or health response alone.

## Cost and follow-up

Use existing owner-published prices/entitlements and gateway accounting. Reserve a
bounded model/test allowance, retain uncertain charges for reconciliation, settle
actual measured usage. Do not send test email or make paid calls without the
necessary approval. Reuse existing authorized monitoring; successful HTTP uptime
does not certify a clean site or CPU/disk/server health.
