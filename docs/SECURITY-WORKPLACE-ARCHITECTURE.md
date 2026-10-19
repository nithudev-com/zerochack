# Security workplace architecture

Scope: the existing Fix hacks & security conversation only. Keep Next.js,
Fastify, Prisma/PostgreSQL, BullMQ/Redis and the central AI gateway. Reuse the
current VPS/domain/Caddy/TLS. No external sandbox service or hosting migration.

## Ownership and trust

| Component | Authority |
| --- | --- |
| Model/planner | Explain evidence and propose supported bounded plans; no authority creation |
| API/tool broker | Derive tenant/site/actor/session, grants, prices, account/pin and budget server-side |
| Workflow controller | One durable journal owner; graph checkpoints are resumable cursors, not approvals |
| VPS-local runtime broker | Admit fixed reviewed image/profile/jobs through a restricted local interface |
| Isolated job | Sanitized disposable snapshot only; no control-plane, engine, vault or live-service access |
| Production executor | Typed approved playbooks with exact resource/preimage/authority binding; no model shell |
| Independent verifier/recovery | Verify actual mutation + regressions; separately authorize recovery and reconcile uncertainty |

Use LangGraph nodes for explicit security states and persisted interruptions, not
another provider stack. All model nodes call the existing AiService/gateway. No
automatic tracing/export of customer context. Graph state contains identifiers,
hashes, versions and sanitized statuses only; encrypted artifacts retain necessary
evidence. Business state and the execution journal in PostgreSQL are authoritative.

BullMQ carries only a versioned run identifier. It wakes the single workflow
controller; it is not an additional mutation retry owner. A fenced lease and
attempt journal are consulted before every side effect. A checkpoint cannot turn
an unrecorded paid call or uncertain production write into a safe retry. Persist
intent before dispatch, retain uncertain allowance, reconcile observed remote
state, and never silently replay a possible write.

## State and approval contracts

Versioned phases: planning, waiting for input/approval, snapshotting, candidate
work, verification, ready for release, applying, post-verifying, completed,
failed, cancelled, stale and OUTCOME_UNKNOWN. A scan completion is never repair
completion. Production success requires exact mutation and independent checks.

An approval binds run/plan/version, selected site/environment, finding/evidence,
source/candidate/manifest hashes, resource identity, typed executor/version,
account/version/pin, recovery receipt/drill, allowance, actor/session/grant and
expiry. Revalidate all authoritative bindings immediately before execution.
Snapshot/test consent is not production-change or recovery authorization.

## VPS-local execution design and open gates

Preferred isolated runtime: gVisor runsc systrap through a separately scoped
engine/OCI broker, initially one job. Do not register it by disrupting the current
production Docker daemon. A rootless service must demonstrate engine-managed
network/user namespaces and enforced cgroupv2 delegation; simple runsc --rootless
convenience mode is not an acceptable substitute.

Jobs use reviewed immutable images, non-root users, dropped capabilities,
no-new-privileges, read-only base and bounded writable storage/time/output/PIDs/
CPU/RAM. Deny networking at creation outside job control; dependency retrieval
is a separate approved cache stage. No host mounts except a broker-created
per-job data boundary, no production secrets/sessions/email/payments, no engine
socket or private services. Private previews need an authenticated origin-isolated
broker. Source archives are untrusted and require traversal/link/expansion checks.

Actual host tests must prove network and metadata/private-service denial, host
filesystem separation, process-storm containment, disk quotas, timeout/crash
cleanup and live-application headroom. Actual separate-engine prerequisites and
outer limits passed; the pinned gVisor rootless/systemd job integration failed
before guest execution. That unresolved compatibility gate, not a proven resource
shortfall, now blocks runtime activation. Ordinary containers/processes are not a fallback.
Even verified gVisor shares this VPS's resource/failure domain; it is not physical
host separation or managed high availability.

See [framework ADR](adr/001-security-workflow-langgraph.md),
[runtime compatibility ADR](adr/002-rootless-gvisor-systemd-blocker.md),
[capabilities](SECURITY-WORKPLACE-CAPABILITIES.md) and
[operations](SECURITY-WORKPLACE-OPERATIONS.md).
