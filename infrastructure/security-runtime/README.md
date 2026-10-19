# VPS-local security runtime — approval-gated, not activated

This is provisioning scaffolding for one offline, disposable security fixture at
a time. It is **not** a live-repair broker, a customer-code activation, or proof
that the future P1–P6 implementation is complete. The scripts have local guard
tests. Approved provisioning installed four prerequisites and the locked UID997
identity. After preserving the first empty extraction stage and correcting the
decoder/binary path, the separate engine passed actual rootless namespace and
aggregate cgroup checks. The first job then failed before guest execution on the
pinned runtime's user-systemd cgroup integration. The dedicated manager/linger
was disabled with data preserved. No job isolation or application activation
has passed. See the [recorded decision](../../docs/adr/002-rootless-gvisor-systemd-blocker.md).

## Measured feasibility, 18 October 2026, 16:48–16:54 UTC

Ubuntu 24.04.5, Linux 6.8.0-139-generic amd64, cgroup v2 and systemd255 are
compatible prerequisites. Available memory was22,931,062,784bytes; available
root disk was8,583,110,656bytes. Keeping5GiB free leaves3,214,401,536bytes of
incremental space. The script imposes a smaller2GiB incremental ceiling. The
95% filesystem-use figure alone does not prove this bounded setup cannot fit.

The four pinned prerequisite packages resolve without upgrades/removals and
occupy about449KiB installed. The pinned official runtime archive is76,363,853
bytes; extraction is capped at512MiB. Prefer a reviewed image at most512MiB
unpacked and256MiB compressed, not a near-1GiB image. Account for content store,
unpacked snapshots, retained archive, daemon metadata and bounded logs; no build,
pull, import or cleanup runs automatically here. There is no reviewed local
runner image yet. Actual footprint must pass the budget again before a job.

Raw unprivileged `unshare` user/network probes failed at UID mapping. RootlessKit
progressed to a more specific missing-`newuidmap` failure. Its bundled Ubuntu
AppArmor profile is already loaded; do not disable AppArmor globally because the
raw probe failed. At that inventory, `uidmap`, `slirp4netns` and `runsc` were absent; an active
delegated runtime user-manager does not yet exist. Thus namespace and cgroup
isolation remain **unverified**, not known impossible.

Production CPU limits total7.5vCPU on8vCPU. A new0.5vCPU allowance would consume
that entire limit budget. This profile instead limits the **whole dedicated
identity**, including Docker, networking, gVisor and its one job, to0.25vCPU,
1GiB RAM, zero swap and256 tasks. Each job is capped at512MiB/64 tasks and shares
the outer CPU budget. Caps are not reservations or a performance certification:
0.25vCPU may be too slow for framework builds. Use bounded timeouts; benchmark
before admitting a workload. Never silently increase these limits.

## Review and approved provisioning

Read every script and the pinned [profile](profile.json). The default `plan`
operation does not administer any host:

```sh
python3 -B scripts/security-runtime/provision.py plan
python3 -B -m unittest discover -s scripts/security-runtime -p 'test_*.py' -v
```

Only after an operator approves a maintenance window and the normal execution
approval, on the verified VPS as root:

```sh
python3 -B scripts/security-runtime/provision.py provision --maintenance-approved
```

It records healthy production container identities, API liveness/readiness,
existing service PIDs and config hashes before/after. It installs only four
exact packages with `NEEDRESTART_MODE=l`, no upgrades/removals, no apt-list
refresh and no production daemon restart. A package transaction outside the
reviewed set is refused. Versions may disappear upstream; review a new pin,
never force or silently select another version.

The new locked-password `codebandage-sandbox` identity has no sudo, Docker, LXD
or other supplemental groups. Subuid/subgid2000000–2065535 must not collide
with any account/range. Existing accounts, unknown homes, changed managed
files and partial archives/extractions fail closed. Reruns preserve all data,
keys and image identities; a failed partial step needs inspection, not reset.

The complete gVisor20261012.0 tar bundle is checksum-pinned and bounded during
extraction. Its root-owned versioned directory retains `gvisor-bin` sidecars.
The official compressed frame declares a128MiB decoder window. The decoder is
bounded to128MiB separately from the512MiB extracted-file ceiling. A64MiB
decoder attempt failed before extraction; the checked archive and log remain.
The official apt `runsc` package is deliberately not installed: its documented
automatic Docker configuration is inappropriate for the existing production
daemon. No `runsc install`, global Docker context, `/etc/docker/daemon.json`,
SSH, DNS, Caddy, firewall, sysctl or global AppArmor change is made.

The application's `/opt/codebandage` ancestor remains private. Only the verified
runtime bundle is copied to root-owned0755
`/usr/local/lib/codebandage-security-runtime/20261012.0`; the dedicated identity
cannot modify it. No state/configuration/key/application bytes are published.
The initial engine attempt failed closed because its old binary path was below
the private application ancestor. For that exact inactive, newly provisioned
engine only, add `--runtime-path-recovery-approved` to the approved `provision`
command. It accepts only the byte-exact previous generated configuration, keeps
a root-private backup, changes only its runtime binary path, and refuses unknown
configuration or an active manager/socket. It never chmods the application
ancestor, changes production daemon settings, or restarts production services.

Only this identity's user-manager delegation/slice and user service are created.
The separate rootless engine uses caller-configured user/network namespaces,
systrap and Netstack, not the single-UID `runsc --rootless` shortcut. That
shortcut lacks the required network/cgroup guarantees. Detached/host-network
acceleration is disabled. The private Unix socket is inside this identity's
0700 runtime directory; never expose it over TCP or mount it into API, worker,
model, tool or customer containers. Socket control remains powerful even when
the engine is rootless; only a future narrowly typed trusted broker may use it.

Provisioning reports `ROOTLESS_ENGINE_PROVISIONED_UNVERIFIED`. It does not
connect a broker or flip any application feature flag. On failed engine checks,
only this dedicated identity's manager is stopped; state and evidence remain.

## Explicit benign verification, then remaining gates

A separately reviewed/imported local image is required. No floating tags/pulls.
It must be the sole local image, at most512MiB unpacked, contain Python3 stdlib,
declare no volumes and carry label
`io.codebandage.offline-runtime-profile=python3-stdlib-v1`. Labels are not proof
of image trust: audit/review the bytes and immutable identity first. Account for
compressed+unpacked copies; do not leave a third image archive on the VPS.

```sh
python3 -B scripts/security-runtime/verify.py \
  --image-id sha256:REVIEWED_LOCAL_IMAGE_ID --benign-fixture-approved
```

The fixed probe has no credentials, provider access or production mounts. It
checks actual host process UIDs/namespaces and cgroup files, readonly root,
one64MiB `/work` tmpfs with observed ENOSPC, disabled IPC shared memory, and
failed loopback/reserved-address connections under `--network=none`. It stops
only its own uniquely named container and retains it/logs. All operations share
one nonblocking provisioning lock, so concurrent probes refuse admission.

Rootless overlay2 on this ext4 host is **not** claimed to support a per-container
`--storage-opt size` disk quota. The offline profile instead has a readonly root,
no writable host/volume binds and only the tested64MiB tmpfs. Docker logs have
1MiB×2 rotation. The trusted engine's metadata is not a hard filesystem quota;
the2GiB budget is an observed admission guard, not an ext4 project quota. If a
future workload needs writable disk or a permanent data volume, it stays blocked
until a real quota-backed design and exhaustion test exists.

Even a passing probe reports `OFFLINE_FIXTURE_VERIFIED_NO_ACTIVATION`. Remaining
gates include a trusted broker enforcing global concurrency1, denying arbitrary
images/mounts/devices/host networking, bounded shutdown/crash/restart recovery,
tenant/credential boundaries, benign repair/restore drills, release audits and
representative application-headroom measurements. No live customer work or
general hostile-code containment is certified by this probe.

## Emergency disable / rollback without data deletion

```sh
python3 -B scripts/security-runtime/provision.py disable --maintenance-approved
```

This stops/disables only the dedicated user service/manager and its lingering,
leaving images, home, runtime binaries, pins, evidence and account intact. It
still works if the normal disk reserve is no longer met. If another operation
holds the lock, first stop that approved provisioning/probe command; do not race
it. Do not remove accounts, ranges, shared packages or data as a rollback shortcut.
No production daemon, application database or migration is downgraded/restored.

If the reviewed decoder failure left the exact root-owned staging directory
**empty**, the explicit recovery command verifies the pinned archive and inactive
new identity, then renames that empty directory to a timestamped preserved name:

```sh
python3 -B scripts/security-runtime/provision.py recover-empty-stage \
  --maintenance-approved --empty-stage-recovery-approved
```

It refuses nonempty/unknown stages, active runtime managers and completed bundles.
Nothing is deleted and provisioning is not resumed automatically. Inspect the
receipt and obtain normal approval for the ordinary `provision` command again.

Official references: [rootless Docker](https://docs.docker.com/engine/security/rootless/),
[rootless resource delegation](https://docs.docker.com/engine/security/rootless/tips/),
[Ubuntu namespace policy](https://docs.docker.com/engine/security/rootless/troubleshoot/),
[gVisor rootless modes](https://gvisor.dev/docs/user_guide/rootless/),
[gVisor full-bundle installation](https://gvisor.dev/docs/user_guide/install/),
[pinned release](https://github.com/google/gvisor/releases/tag/release-20261012.0),
[systrap](https://gvisor.dev/docs/user_guide/platforms/).
