# Security workplace operations — existing VPS

Use the existing trusted SSH/key connection; never reuse exposed chat passwords.
Production checkout `/opt/codebandage/source`, protected secrets/trust
`/opt/codebandage/state`, release manifests `/opt/codebandage/releases`, current
database backup directory `/opt/codebandage/backups`. Host Caddy terminates HTTPS;
application ports bind loopback and database/Redis stay on private TLS networks.
Keep `codebandage.com` routing/TLS/domain unchanged. No new cloud account/DNS needed.

## Interrupted provisioning observation — 18 October 2026

An explicitly approved attempt used the reviewed setup archive
`b4a49af3449a2a7439a4c1935c0fc0c1662b3253b90261d17e6d2ccd808eaa6e`
under `/opt/codebandage/runtime-setup-b4a49af3-20261018`. The four pinned
rootless prerequisites and locked `codebandage-sandbox` identity (UID997) were
created. The gVisor archive passed its size/hash guard, but extraction stopped:
its actual Zstandard frame requires a128MiB window and the first decoder limit
was64MiB. The empty staging directory and failure log were preserved. Engine
configuration/start and application activation were **not reached**.

At17:14UTC all five production services were still healthy, and free disk was
about8.5GB. Starting17:17UTC, trusted-key SSH and public HTTPS connections timed
out; a17:23UTC SSH retry also timed out. The cause is not established. The owner
was asked to inspect the trusted VPS console without rebooting. Do not describe
the earlier healthy observation as current availability or infer that the
provisioning failure caused the connectivity loss.

The local fix retains a128MiB decoder bound and adds an explicit
`recover-empty-stage` operation which only renames a verified empty, owned stage
and retains evidence. At that checkpoint recovery required restored access, a
current workload inventory and normal execution approval. Never
delete/reset a partial nonempty stage or blindly restart an existing daemon.
The runtime scripts are [documented here](../infrastructure/security-runtime/README.md).

## Current measured gates — 19 October 2026

At 02:57 UTC the existing VPS reported 8 vCPU, 25,199,173,632 bytes RAM,
23,973,228,544 bytes available RAM, no swap, and 9,548,242,944 bytes free root
storage (94% used). Load averages were 0.30/0.30/0.28. These are idle observations,
not workload capacity certification. All five production containers were healthy;
API liveness and dependency readiness returned database/Redis up. Docker and Caddy
were active. The production checkout remained clean/detached at `7279cda`, with
unchanged Caddy configuration. Revalidate before each new admission.

Earlier access returned at 18:18 UTC on 18 October. Boot records show shutdown at
17:16 UTC and boot at 17:44 UTC into kernel 6.8.0-147-generic. No agent reboot
command was executed and the cause is not established. The earlier reachability
request is no longer a current blocker.

The real disposable managed-static SSH repair/restore and lost-ack drills passed
18:34UTC, with all nine fixture containers stopped/retained. Evidence and exact
source identity are recorded in verification. These fixtures do not activate a
customer repair capability or establish a customer-code sandbox boundary.

The separate rootless engine passed its actual user/network namespace and outer
cgroup-v2/systemd checks on 18 October: 0.25 CPU, 1 GiB memory, swap zero and
256 tasks. The official gVisor 20261012.0 guest then failed before startup with
`systemd error: Interactive authentication required`. See
[ADR002](adr/002-rootless-gvisor-systemd-blocker.md). Guest/adversarial isolation,
per-job resource enforcement, disk quotas and runtime cleanup are **not verified**.
Existing production CPU caps total 7.5 and memory caps 8.25 GiB; caps are not
reserved capacity. Start no untrusted job until every required boundary passes.

At 01:47:26 UTC on 19 October only the newly provisioned runtime user manager and
linger were stopped. `user@997.service` was still inactive at 02:57 UTC. Runtime
state, keys, verified binaries, image and failed-created container were retained;
the production Docker daemon was not restarted/reconfigured. The benign probe
image is `sha256:c48a6340d3aca90fcb3bb5b29468c655112dd9ab9648c8dbe898abe41de67551`;
its fresh Trivy HIGH/CRITICAL audit passed with zero findings. This does not clear
the separate existing application-image audit blockers.

Do not install the unmerged runtime patch, ignore cgroups, broaden polkit or
silently fall back to ordinary containers. A pinned custom-runtime build review
has been offered to the owner; no approval or installation is assumed. Its build
resource needs have not been measured. No new cloud account is needed for this
decision. The upstream runtime gate is separate from unfinished product admission,
exact MFA/payment authorization, inline cards and playbooks B–I.

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

The dormant security controller implements fencing, leases, bounded drain and
retained in-flight uncertainty. It has no registered product admission/production
executor. Its future activation must preserve those boundaries. Browser
stop-generation is not cancel-job.
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

## Development and CI continuation

The additive `20261018000000_security_repair_journal` migration was tested with
31 migrations on disposable PostgreSQL only. Production still has 30 applied
migrations. Do not deploy the migration, start the dormant dispatch factory or
enable a security capability merely to match repository state.

Default local integration guards still require the explicit isolated container
hosts, source/attempt-specific database, matching ownership/comment and Redis DB3.
The separate `LEGACY_GITHUB_ACTIONS` mode requires the exact GitHub-hosted
repository/run/source binding. Its preparation script creates only a new uniquely
named test database or reuses the exact marked owner; unknown databases are
refused, never reset/dropped. CI's existing moderate-level npm audit remains
blocking before preparation. This plaintext disposable CI mode is not production
PostgreSQL/Redis TLS evidence. The actual GitHub workflow must be inspected after
publication; local protocol tests are not a hosted CI run.

Protected local evidence is outside Git at
`/home/nithu/codebandage-website-tools-evidence`. The V4 local TLS fixture
is `/tmp/codebandage-p1-c6009e63269f-8cb4b489-k8oh4epm`; retained fixture identities
and reports are recorded there. Its exact two owned services were stopped with
exit 0 at 03:17 UTC on 19 October, after ID/image/label/private-network/mount checks.
The separately created broader legacy fixture was stopped earlier after 233
passing integration tests and one explicit optional live-scan skip. Both used
disposable bounded tmpfs; stopping ends test data, not retained evidence. No
retained fixture-service container/network/key/report was deleted. Short-lived
trusted test clients used their declared automatic cleanup. Never substitute an existing user's database/Redis for
these fixtures, run their integration suite against production, or archive their
authentication files into the repository/CI artifacts.

## Cost and follow-up

Use existing owner-published prices/entitlements and gateway accounting. Reserve a
bounded model/test allowance, retain uncertain charges for reconciliation, settle
actual measured usage. Do not send test email or make paid calls without the
necessary approval. Reuse existing authorized monitoring; successful HTTP uptime
does not certify a clean site or CPU/disk/server health.
