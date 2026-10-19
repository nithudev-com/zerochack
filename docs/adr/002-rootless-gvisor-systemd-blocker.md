# ADR002 — Do not bypass the rootless gVisor resource-control failure

Date:2026-10-19. Status: **job activation blocked; evidence retained**.

The existing VPS remains the only intended execution host. Actual dedicated
rootless Docker29.8.2 provisioning succeeded with separate user/network namespaces,
systemd cgroupv2 delegation and verified outer0.25CPU/1GiB/swap0/256task limits.
The production Docker daemon, Caddy, domain, certificates and private application
directory were not reconfigured. Only verified runtime binary bytes were copied
to a dedicated root-owned executable directory.

The official checksum-pinned gVisor20261012.0 benign job failed during OCI creation:
`systemd error: Interactive authentication required`. The guest did not start.
The created container76b8b6ce1229982f943183dc15d0b438b4b406d1eb6039374ca58b0bfd577483,
logs, bundle, image and state are retained. The dedicated manager/linger was
disabled at01:47:26UTC; production stayed healthy. No customer code was executed.

Pinned [runtime source](https://github.com/google/gvisor/blob/release-20261012.0/runsc/cgroup/systemd.go)
uses the system manager. The still-open
[upstream fix13853](https://github.com/google/gvisor/pull/13853) addresses user-manager
selection, namespace-translated credentials/paths and requested-controller checks.
This matches the observed error; merely setting a session-bus variable or a
rootless flag does not implement those changes. Its reported tests are upstream
claims, not our VPS evidence.

Decision: do not use ignore-cgroups, broaden polkit permissions, disable security
controls, or switch to rootless cgroupfs and label limits enforced. Docker's
[rootless resource controls](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources)
require cgroupv2/systemd. Do not install an unreviewed/unmerged runtime patch or
silently replace this boundary with ordinary containers or external services.

Next gate: a separately reviewed immutable fixed official/runtime build, or an
explicitly approved alternative local OCI integration with equivalent boundaries.
Review its provenance and controller handling, then demonstrate actual guest
execution, every helper's cgroup ancestry, CPU/memory/PID/storage enforcement,
network/private/metadata denial, cancellation/crash cleanup and production
headroom. A dedicated rootful service would be a new privileged trust boundary,
not an unprivileged workaround; it requires its own decision and authorization.

Independent journal/approval/typed-adapter development may continue. Sandbox
availability and customer repair success must remain false until their own gates
pass. This ADR is not P3/P4/P5 completion or a claim that the VPS lacks resources.

## Read-only source check and candidate broker, 19 October 2026

The official [release list](https://github.com/google/gvisor/releases) still marks
`20261012.0` latest; [PR13853](https://github.com/google/gvisor/pull/13853) remains
open. No runtime bytes, pins, system services or permissions were changed in this
development session. The local development environment has neither Docker nor
runsc, so it cannot validate a guest or replace VPS execution evidence.

An external user-systemd transient unit is a possible separate design review, not
a supported workaround established here. The official
[container implementation](https://github.com/google/gvisor/blob/master/runsc/container/container.go)
`createRoot` assigns a default `CgroupsPath` when empty (apart from the explicitly
test-only no-chroot path) and invokes `setupCgroupForRoot` before starting gofer/
sentry whenever `IgnoreCgroups` is false. Therefore omitting OCI resource settings
does not establish that runsc stops managing cgroups. These current-master source
observations are not byte-level verification of the pinned binary. Systemd's
[transient units](https://www.freedesktop.org/software/systemd/man/255/systemd-run.html)
and [resource controls](https://www.freedesktop.org/software/systemd/man/255/systemd.resource-control.html)
can enforce limits, but any proposed direct OCI route must prove the pinned
runtime joins that exact unit with every helper, retains UID/network isolation,
and cannot migrate helpers or workload outside it. No ignore-cgroups, test-only
flag, rootless cgroupfs switch or expanded root/polkit trust is enabled.

The additive `scripts/security-runtime/broker.py` implements a bounded one-shot
JSON protocol, exact image/profile admission, process I/O limits, exact-job
cleanup and durable consumed admissions/results. Its only candidate profile is
offline Python syntax/unittest verification; it is not a customer SSH write,
malware cleanup, npm install or general repair executor. It requires fresh
actual `candidateBroker` fault/containment proof in the root-owned verification
receipt. The current verifier does not emit those unpassed gates, so even a
historical basic probe PASS cannot activate this broker. Local transport fixtures
and real benign subprocess tests verify the implementation without claiming
gVisor availability. The VPS compatibility blocker remains open.
