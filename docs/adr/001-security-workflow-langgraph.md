# ADR001 — Security orchestration, existing gateway and local runtime

Date: 2026-10-18. Status: **accepted for P1 development; execution not activated**.

Decision direction: LangGraph.js inside the existing backend/worker, preserving
AiService as the provider/billing boundary and Prisma/PostgreSQL as authoritative
business state. BullMQ dispatches identifiers; one journal controller owns effects.

Registry metadata inspected on18October2026:

- `@langchain/langgraph`1.5.1: Node>=18, core^1.1.48, Zod^3.25.32 or^4.2.0.
- checkpoint-postgres1.1.0: Node>=18, core^1.1.44, checkpoint^1.2.0.
- core1.2.18: Node>=20.
- Existing build/runtime Node22, TypeScript5.9.3 and locked Zod4.5.4.

Actual compatibility spikev2 passed on the existing VPS using disposable
PostgreSQL over verified TLS and three separate Node22.23.3 processes: persisted
pause, saved exact decision, resume after process exit,4retained checkpoints and
one existing AiService/gateway call through a synthetic adapter. No live provider,
paid call or production mutation occurred. The first fixture failed because it
omitted the membership required by an existing database foreign key; that failure
and its STARTED journal were retained, not replayed. The corrected fixture uses a
new run/schema. Node22.22.2/TypeScript5.9.3/Zod4.5.4 local API/types and9graph/
encrypted-checkpointer protocol tests also passed. At that initial checkpoint the
real Prisma saver/journal and broader gates were pending; see the continuation below.

LangGraph interrupt nodes restart from their beginning when resumed. Do not place
unguarded side effects before an interrupt. A checkpoint is not an exactly-once
execution journal or a grant. Keep state/reference schemas small and strict,
validate tenant-scoped thread mapping server-side, and prohibit arbitrary thread
IDs/checkpoint browsing from model/browser inputs.

Choose a scoped encrypted BaseCheckpointSaver using Prisma's existing connection
and reviewed additive tables. Installed official saver1.1.0 persists checkpoint
metadata asJSONB and has a separate pgpool/runtimeDDL setup interface. Reusing
Prisma allows atomic lease/authority checks with cursor writes and avoids a second
TLS/pool/migration owner. The spike used the official saver only in its isolated
fixture schema; it does not certify the new adapter. The new adapter encrypts
checkpoint+metadata/pendingwrites, accepts plain boundedJSON only (no constructor
revival), rejects arbitrary thread/subgraph/history deletion and retains history.
No source, messages, credentials or free-form model output belong in graph state.

Installed API detail: the initial framework uuid6(clockseq=-1) checkpoint has a
hexadecimal UUID shape with variantffff. Only internal checkpoint identifiers use
a shape validator; actor/site/run/decision UUID validation remains strict. Test
pending-write ordering and interrupted resume against actual persisted storage.
Use synchronous checkpoint durability; finalize terminal business state/fencing
only after its final cursor is persisted. Business/journal authority still wins.

Alternatives: an existing custom runner reduces dependencies but makes durable
graph semantics our responsibility. OpenAI Agents SDK is not rejected for lacking
tools/sessions/approvals; another provider/runtime layer is unnecessary here
without a concrete demonstrated advantage. Deep Agents is broader than the narrow
security contracts. No eve/provider/framework migration is part of this request.

## 19 October implementation continuation

The encrypted Prisma saver, additive seven-table migration, journal/controller,
saved candidate decisions and dormant outbox/BullMQ path are implemented. The
broader disposable TLS PostgreSQL/Redis run passed 60 new orchestration cases
alongside 173 existing integration cases, with one optional live scan skipped.
Final source `98ffec1` passed 1,005 unit tests, full lint and all 20 workspace
typechecks. Scope/thread/checkpoint ancestry, decision freshness, fencing, uncertain
costs/effects, cancellation and terminal-cursor restart behavior have dedicated
tests. Automatic external tracing and inherited trace context are refused rather
than exporting checkpoint/customer context to LangSmith.

These checks support the framework choice, not a completed security product.
Current-actor/grant/payment/MFA admission and actual registered gateway/sandbox/
production handlers are unfinished; production migration/dispatch is not enabled.
The separate local runtime encountered an actual upstream compatibility blocker,
recorded in [ADR002](002-rootless-gvisor-systemd-blocker.md). No executor fallback
or new provider stack was introduced. See the exact
[verification record](../SECURITY-WORKPLACE-VERIFICATION.md) for source manifests,
fixture limitations and failed attempts preserved alongside passing evidence.

Official references reviewed:
[overview](https://docs.langchain.com/oss/javascript/langgraph/overview),
[persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence),
[interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts),
[gVisor rootless modes](https://gvisor.dev/docs/user_guide/rootless/),
[Docker rootless prerequisites](https://docs.docker.com/engine/security/rootless/).
