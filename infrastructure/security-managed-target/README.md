# Managed-static permission helper — unregistered fixture adapter

Status: **not enabled in the application**. The baseline disposable SSH/filesystem
fixture at source manifest `584c2a2e576f1ab8b57f47fceb691ceaa55f285d968e68c28e41a665f72e6d2b`
passed normal and lost-ack variants on 2026-10-18 (operator-reported 18:34 UTC).
The additive reconciliation protocol below is **local-only and has not been run in
that VPS fixture**; baseline evidence does not validate these later local changes.
This is a narrow P2 engineering primitive, not completion of the Security workplace,
not a payment/entitlement implementation, and not support for repairing an existing
Hostinger, WordPress, shared-hosting or arbitrary customer SSH filesystem.

## Exact supported operation

`MANAGED_STATIC_PERMISSION_V1` supports one **newly provisioned** root-owned regular
`index.html`, at most 200,000 bytes, inside a dedicated managed static namespace.
HARDEN removes only POSIX other-write (`0002`). Separately approved RESTORE restores
that bit on the same inode after verifying the original encrypted recovery data and
the exact current verified snapshot. Neither operation changes file contents.
Only STAGING is accepted. There is no production executor registration or fallback.
PHP execution, malware removal, arbitrary edits, commands and paths are unsupported.

Do not copy a customer file into this namespace and describe hardening the copy as a
repair of the original website. Migration/publication would need separate explicit
authorization and independently verified application behavior.

## Filesystem guarantee and its trusted boundary

The trusted provisioner creates a **fresh** backing root (`0700`, UID/GID0), a `site`
child (`0755`, UID/GID0), and a **new** single-link root-owned `index.html`. Adopting an
old inode is forbidden: changing permissions does not revoke a pre-existing open
write descriptor. The publisher receives only a read-only bind of the child, with
recursive submounts disabled, private propagation, separate mount/PID namespaces,
non-root UID, no capabilities and no-new-privileges. It has no backing-parent, state,
keys, Docker socket or helper filesystem mounts. Other host non-root identities
cannot traverse the private ancestor. Only the trusted helper has an RW backing bind.

The immutable provisioner manifest is a root-owned `0400` single-link file in a
root-owned `0700` **read-only** bind. It binds namespace, tenant, website, STAGING,
target identity, profile digest, and backing/site/state/target device+inode identities.
A request supplies IDs, never a path or an `exclusiveWriterConfirmed` checkbox.
The helper checks actual private mount points, absence of submounts, CapEff0,
no-new-privileges, root/parent ownership and modes, dirfd/O_NOFOLLOW opens, device,
inode, nlink1, size, uid/gid, exact mode, nanosecond mtime/ctime, and content hash.
Target identity is checked **before** reading any bytes. Full metadata is checked
before/after every bounded read. The same open FD is used for fchmod and verification.
Backing and journal mounts must report local ext4 or XFS; tmpfs, overlay and network
filesystems are refused rather than claiming disk durability from an unverified profile.

The underlying boundaries are documented by [Docker's bind-mount guide](https://docs.docker.com/engine/storage/bind-mounts/),
the [Linux fchmod interface](https://man7.org/linux/man-pages/man2/fchmod.2.html),
and [Linux fsync/directory durability requirements](https://man7.org/linux/man-pages/man2/fsync.2.html).
The advisory-only nature of [flock](https://man7.org/linux/man-pages/man2/flock.2.html)
is why it is not the independent-writer security boundary.

Root, the Docker daemon, provisioner, helper/server binaries, crypto codec and their
runtime are the **trusted computing base**. A hostile host root/Docker administrator,
malicious helper, an extra RW bind, a leaked backing FD or an unreviewed namespace
setup breaks the guarantee. A manifest or profile hash alone cannot prove that no
other privileged process exists. Product admission must verify trusted provisioning
and fresh container/mount inventory; the current application does not do this.
`flock` serializes trusted helper requests only; it does not exclude hostile writers.

The disposable runner inventories the actual mount/security boundaries, then the
non-root publisher actually attempts write, chmod, rename and hardlink and requires
`EROFS` for each. The private HTTP fixture verifies the full served-content hash
before and after hardening and independently approved restore. This proves this
specific fixture profile, not arbitrary hosting. The Node fixture publisher serves
only the synthetic static file; it never executes customer source.

## Protocol and authority

SSH uses a dedicated public-key identity, pinned SHA256 host key, and one literal
exec request: `codebandage-managed-target-v1`. The disposable `ssh2` server rejects
shell, SFTP, PTY, environment and forwarding requests and spawns a constant isolated
Python invocation with `shell:false`. It is not a production sshd installation.
The default broker requires an explicit public IPv4 address, never a DNS lookup or
private/link-local address; only the separately named fixture client injects a
private-network connector, still with a pinned host key. No password auth is offered.

Allowed request commands:

| Command | Effect |
| --- | --- |
| OBSERVE | Reads exact bound target metadata/content hash; does not return bytes. |
| PREPARE | Requires exact approved snapshot/plan/authority digests; creates and verifies encrypted recovery plus durable challenge. Does not mutate target. |
| COMMIT | Requires a fresh, action-specific, one-shot HMAC permit for that challenge and snapshot; performs one fchmod only. |
| STATUS | Returns durable journal state only; no write, retry or automatic compensation. |
| RECONCILE_OBSERVE | Reads an uncertain original journal, verifies recovery and observes the exact current target; returns fresh evidence for separate observational approval. |
| RECONCILE | Requires a distinct signed observational permit; appends one new receipt without changing the target, original journal, recovery, or mutation admission. |
| RECONCILIATION_STATUS | Reads an existing append-only receipt by exact operation and reconciliation IDs; no target mutation or retry. |

Permit scope includes tenant, website, STAGING, run, namespace, target, operation,
HARDEN/RESTORE, exact target mode, plan/authority/snapshot/recovery digests, challenge
and timestamps. TTL is at most 15 seconds and is rechecked just before INTENT.
`authorizeAndIssuePermit` is intentionally **absent** by default: commit refuses with
`UNREGISTERED_SECURITY_EXECUTOR`. A future real authority must validate current
actor/session, durable exact approval, lease/fence, scope, target/provisioner binding,
entitlement and budgets before issuance. Short-lived permits leave a bounded remote
revocation gap; do not claim instantaneous cancellation after a permit was issued.
The fixture signer is synthetic authority for synthetic files, not that implementation.

The broker has bounded connection/authority/command deadlines, bounded stdin/stdout/
stderr, fixed exec, client/channel cleanup and no retry. Canonical data is ASCII-only,
depth<=12, nodes<=512, width<=64, string<=600KB and serialized<=786KB; cycles, getters,
duplicate JSON keys (Python), floats/nonfinite numbers and unknown protocol keys are
refused. Nanosecond/inode/device values are decimal strings, not unsafe JS numbers.

## Encrypted recovery and uncertain outcomes

The provisioner generates independent random 32-byte AES and HMAC keys, only when
creating a fresh fixture. They are protected files, not environment variables,
command-line arguments, Git data or log output. Never regenerate keys to recover an
existing namespace. `recovery-codec.cjs` uses Node's standard AES-256-GCM with random
12-byte IV, authenticated canonical scope/snapshot AAD and the full original bytes+
metadata. A separate fixed CJS subprocess reads the protected key directly; Python
does not implement crypto. Input/output, heap, duration and private temporary output
files are bounded. Recovery is fsynced, reread, decrypted and hash/metadata checked
before any target mutation. Restore verifies the referenced original recovery too.

State is root-private and bounded to 16 operations, about 8MiB encrypted recovery
plus small journals. No automatic deletion or pruning exists. PREPARED is durable;
COMMIT first fsyncs **INTENT plus consumed permit digest**, including the state
directory, and only then calls fchmod. It fsyncs the target and records VERIFIED only
after exact readback, permitting only the expected mode/ctime change. Every failure
after INTENT is OUTCOME_UNKNOWN. Repeated COMMIT is always refused, even after success.
Lost acknowledgement can be reconciled by STATUS if a durable VERIFIED receipt exists.

An INTENT/OUTCOME_UNKNOWN without a durable verified original receipt blocks all
further mutation in that namespace. It cannot be reset, retried or automatically
restored. The local observational extension adds evidence while preserving that
original uncertain state and consumed permit. Recovery admission over such an
uncertain original remains an **unfinished local gate**, including when the current
snapshot matches the expected postimage. Normal separately approved RESTORE from an
original VERIFIED HARDEN operation remains supported as before.

### Local observational reconciliation

`inspectReconciliation` / `RECONCILE_OBSERVE` requires exact tenant, website,
STAGING, run, namespace, target, original operation and a different new reconciliation
UUID. Only durable INTENT or OUTCOME_UNKNOWN originals qualify. The helper verifies
the original encrypted recovery, reads the same identity-bound target and returns
the canonical source-record digest, source state, before/current snapshots and
digests, action/mode, fresh challenge and observation time. It does not persist a
proposal or change the original journal. An original VERIFIED receipt uses STATUS;
it does not need this extension even when its acknowledgement was lost.

There are exactly three snapshot relationships:

| Classification | Meaning |
| --- | --- |
| MATCHES_BEFORE | All current snapshot fields exactly equal the original before-image. |
| MATCHES_EXPECTED_POSTIMAGE | All fields match the original before-image except the authorized one-bit target mode and the observed ctime. |
| DRIFT | A readable, profile-valid current snapshot matches neither relationship. |

These labels do **not** establish whether fchmod ran, durability at a past crash,
APPLIED/NOT_APPLIED, or original operation success. Same permission bits with a
changed ctime are DRIFT. Changed content is DRIFT even when permission bits match
the expected postimage. An inode, ownership, link, mount, size or unsupported-mode
failure can prevent safe observation entirely; it returns a refusal and leaves the
original uncertain. There is no fallback read of an unbound inode.

`reconcile` requires the separately configured
`authorizeAndIssueReconciliationPermit`; the normal mutation-authority callback
cannot authorize it. The HMAC key is the existing protected permit key, with a
distinct exact payload domain, not a new key or a COMMIT permit. The authority must
approve this observational action and exact evidence, including current actor/
session and durable approval in a future product integration. The payload is:

```text
version: 1; adapter: MANAGED_STATIC_PERMISSION_V1;
purpose: OBSERVATION_RECONCILIATION_V1;
scope; namespaceId; targetId; operationId; reconciliationId;
observationDigest: SHA256(canonical(full observation));
sourceDigest; currentSnapshotDigest; issuedAt; expiresAt
```

The helper compares every field and the HMAC, requires
`observedAt <= issuedAt <= now < expiresAt <= observedAt + 15000`, rereads the
source journal and current snapshot under its helper lock, and rechecks freshness
immediately before appending. Journal changes, ctime/content changes, scope changes,
wrong action/domain/key, stale permits and altered evidence fail closed.

Receipts are bounded to 16 files of at most32KiB per namespace and use a new
`<reconciliationId>.reconciliation` filename opened O_EXCL/O_NOFOLLOW. Existing
receipts are never replaced. The helper fsyncs the file and state directory and
rereads the receipt before returning RECONCILED_OBSERVATION_ONLY. Receipt content
retains the full observation, consumed observational permit digest, recording time
and canonical receipt digest; it contains no file bytes or key material.
Neither original journal nor original recovery is rewritten, and the uncertain
original continues blocking PREPARE/COMMIT. A postimage match therefore cannot
silently authorize RESTORE, repeat COMMIT or release the namespace for other writes.

A lost receipt acknowledgement is MANAGED_RECONCILIATION_RECEIPT_UNKNOWN, distinct
from target-outcome uncertainty. Read RECONCILIATION_STATUS with the same IDs;
never automatically send another RECONCILE or mutation. A crash during append may
leave a partial/corrupt receipt; it remains on disk, cannot be overwritten, and
STATUS refuses it. The current implementation has no receipt repair, deletion,
pruning, recovery-admission override or bypass for an uncertain original. Actual
crash/process-kill filesystem and SSH fixtures for this local extension remain
required before deployment, alongside independent review of any later recovery gate.

For real disaster recovery retain the original AES/HMAC keys, manifest/provisioner
identity, encrypted recovery files and journal together, with secure off-server
storage and tested restore access. These fixture files on the same host are **not**
off-server backup or disaster-recovery evidence. Never archive the private fixture
directory or authentication files into source, CI artifacts, image layers or debug logs.

## Tests executed versus prepared

Executed locally before this extension: Node22.22.2 codec6, in-memory broker7, Python3.13.12 validation12;
all passed. These include real AES-GCM roundtrip at the 200KB boundary and tamper/
wrong-key/AAD/digest rejection, bounded/cyclic canonical data, permit scope/TTL/action
checks, fixed command, output bounds, cleanup, cancellation and lost-ack unknown/no retry.
The additional mocked-filesystem ordering cases prove INTENT precedes the one-bit
call, failed recovery/drift makes no call, post-call durability failure remains UNKNOWN,
replays are refused by a fresh process, corrupt journal modes are rejected and RESTORE
cannot reuse a HARDEN permit. The first mock replay test reused the one-shot process
object incorrectly; after correcting the fixture to reopen the persisted journal,
all12 Python cases passed. No target file was modified by these mocked cases.
Those mocked cases do **not** prove filesystem isolation or actual SSH behavior.

Local reconciliation verification: codec6, broker11 and Python21 pass. New mocked
crash/restart cases stop after durable INTENT but before fchmod, after the mocked
fchmod but before its verified receipt, and after durable VERIFIED but before ack.
The first two append separately authorized observational evidence without changing
the original state; the third retains ordinary VERIFIED STATUS. Tests cover changed
ctime with unchanged bits, content drift, duplicate receipt refusal, distinct
authority/domain, signed wrong bindings, expired/future/stale permits, source/current
changes, unchanged original journals, continued replay/mutation refusal and lost
observational acknowledgement without retry. One local receipt-storage test uses
temporary files to verify O_EXCL,0600, readback and retention/refusal of interrupted
partial receipts. It never provisions a managed namespace or writes/chmods a target.
These are local tests, not actual crash durability or SSH validation of the extension.

To rerun local tests (no SSH, containers or target mutation):

```sh
node infrastructure/security-managed-target/codec.test.cjs
node infrastructure/security-managed-target/broker.test.cjs
python3 -B infrastructure/security-managed-target/helper_test.py
```

The operator reported the baseline `584c...` fixture PASS for actual pinned-key SSH,
read-only publisher EROFS proof, before/after HTTP digests, bad host key/command/scope/
permit refusal, real harden/separate restore, replay refusal and a separate fixture
that deliberately loses a successful COMMIT acknowledgement. All9 fixture containers
exited0; production health, Caddy configuration and7279 remained unchanged. No
customer host or credentials were involved. This source now differs from that
reviewed/executed manifest and needs a separate review before another actual run.
Further actual fault fixtures (symlink/hardlink/inode drift,
recovery-storage faults and crash between INTENT/fchmod/receipt) are still required
before the primitive can be considered validated, followed by actual validation of
the local reconciliation extension and product-level gates. No 100% availability
or repair guarantee is made.

## Operator-reviewed disposable fixture run

Do not execute until the helper/profile, fixture source and authority assumptions
have been reviewed and normal execution approval is satisfied. It runs only as root
on reported VPS `vmi3643652`, only from
`/opt/codebandage/audit-managed-target-20261018/source`, and requires an independently
recorded source-manifest SHA256 argument. Preparing this guide is not such approval.
Never run it on the workstation or replace its hostname/path guard to make it work.

The source manifest hashes these basenames in this exact order, then hashes the
`sha256sum` output; compare the independently reviewed value before invoking:

```sh
sha256sum broker.cjs broker.d.cts broker.test.cjs codec.test.cjs \
  fixture-client.integration.cjs fixture-provision.cjs fixture-publisher.cjs \
  fixture-server.cjs helper.py helper_test.py recovery-codec.cjs \
  run-disposable-fixture.sh README.md | sha256sum
```

After approved secret-free source upload and root-owned0700 audit-directory setup:
the `source` directory must be root-owned0755 and the exact13 reviewed source files
root-owned0644 so the non-root publisher can read its entry point through the bind.
The runner checks these modes before creating anything and never changes them.
The audit ancestor remains0700, and keys/private namespace files are elsewhere0700/
0400/0600. Do not loosen private fixture/key permissions to satisfy the source check.

```sh
MANAGED_TARGET_DISPOSABLE_FIXTURE_APPROVED=1 \
  bash /opt/codebandage/audit-managed-target-20261018/source/run-disposable-fixture.sh \
  REVIEWED_SOURCE_MANIFEST_SHA256
```

The script pins the existing tools image by immutable identity
`sha256:da28bd93be2abb9ab8ebfb9d2d9226d1fce32acf022144be618c03aefe45d4e2`, uses no install,
creates no public ports, creates uniquely named internal Docker networks, caps each
container at512MiB/CPU0.125/pids96, drops all capabilities, bounds logs, requires5GiB free disk,
and uses readonly roots/source. The host Python3.12 binary, stdlib and libexpat are
explicit readonly **trusted fixture runtime** mounts, not a customer sandbox; ldd is
verified inside the pinned image first. This cached test image is not a newly audited
production release artifact. Root/Docker socket access on the host is administrative.

It creates two fresh private namespaces (normal/lost-ack), never resets an older
fixture, stops only its exact ephemeral helper/publisher containers, and retains
private logs, image/source identities, inventory, keys, backing bytes, recovery/state,
stopped containers and networks for review. Review exact recorded paths/IDs before a
separately approved cleanup; never use broad deletion, volume prune or Docker prune.
No live service, database, SSH daemon, application flag or production route is modified.

The client is created and tracked by its exact container ID before execution, has
a180-second outer deadline, and is stopped by the bounded fixture trap even if its
attached Docker command times out. This is trusted fixture lifecycle protection,
not proof of an untrusted customer-code execution sandbox.

At most the helper, publisher and client run together: their CPU caps total0.375
and memory caps1.5GiB. Check actual host load and live health before/after; caps are
not reservations or a performance guarantee. No runtime/build load runs in parallel.
