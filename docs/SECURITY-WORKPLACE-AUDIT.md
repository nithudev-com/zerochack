# Security workplace audit — 18 October 2026

This is a source and infrastructure audit, **not a repair-readiness certificate**.
The implementation base is the upgrade branch, not older `main`.

## Baseline and preservation

- Source baseline: `fa4e8668fc4a773372f9b44d8e2b39037b4f92d2`.
- Focused branch: `codex/security-workplace-vps-execution`.
- First focused change: `7279cda5188868db6848f21b2bc18a4a046fb024`, website-only
  inspection/legacy-evidence confinement and truthful limited-coverage presentation.
- No existing history, encrypted evidence, customer configuration or broader ledger
  status was reset. No repair/execution flags were activated.

| Existing behavior | Authoritative records / entrypoints | Preserve / regression evidence |
| --- | --- | --- |
| Secure capture, replacement, expiry, revocation | `care/service.ts`, `care/routes.ts`; CareCredential, bridge, grants | `care.integration.test.ts`; no credentials in chat/checkpoints/queues |
| First-connection trust and subsequent pinning | `customer/ssh-host-trust.ts`, `ssh-toolkit.ts`; append-only audit anchor | `ssh-connection.test.ts`, transport tests; first trust is not independent provider verification |
| Explicit read-only inspection | `customer/routes.ts`, assessment authority/state/scope | `security-assessment-lifecycle.integration.test.ts`, toolkit/transport tests; connect never starts a scan or repair |
| Selected-website isolation | persisted normalized hostname; `assessment-scope.ts` | Reject sibling/account-wide evidence; legacy records retained but excluded from new scoped actions/AI context |
| Chat/gateway/usage | `ai/service.ts`, `ai-gateway/index.ts`, `anthropic.ts`; AiUsage, tenant policy | Existing bounded tool loop, screening, cancellation, pricing and no tool-bearing replay retained |
| Specialist remediation gates | `specialist/routes.ts`, `security/remediation.ts`; assignment, authorization, temporary session, backup | `specialist-mutation-gate.integration.test.ts`; unavailable executor and no-verified-mutation refusals remain |
| Source review and static HTML | CareJob/Revision/Artifact/Release; `care/{review,repair,release}-service.ts` | Existing integration/static fixtures; no expansion into WordPress/security mutation |
| Recovery and retention | encrypted artifacts; `recovery-readiness.ts`, backup worker | A metadata row is not verified bytes or a restore drill; preserve keys/history and unknown outcomes |
| History, drafts, backoff, cancellation | SecurityChat, activity mapper, query policy | Security browser tests; never retry a browser mutation automatically or equate cancelled UI with remote undo |
| Other six workplaces | Workspace service picker/availability | `services.spec.ts`, `workbench.spec.ts`; availability and behavior unchanged |
| Commercial/auth/agency/affiliate | existing roles, sessions, orders and provider flows | Full disposable integration suite is required after shared changes; never infer payment or owner prices |
| Offline verification | `infrastructure/verification`, explicit profiles | Existing profile checks; not a customer-app sandbox or evidence of live security repair |

The mandatory source paths in the owner handoff were reviewed, including the
Prisma scope constraints, current migrations, production Docker/Compose/Caddy
configuration and matching installed Next.js documentation. Detailed security
requirements are traced in [the phase plan](SECURITY-WORKPLACE-PLAN.md).

## Concrete gaps found

1. The six chat tools are inspection/handoff tools, not mutation tools. Assessments
   return `repairApplied: false`. The gateway already has a bounded tool loop.
2. `/specialist/.../remediate` intentionally stops before creating a mutation run;
   post-scan completion refuses `NO_VERIFIED_MUTATION`. Old remediation prose was
   inconsistent with those guards and must not be treated as implementation.
3. `security-permission-target.ts` can issue one SFTP `fchmod`, but ordinary SFTP
   cannot prove inode/link identity, hostile-ancestor safety or exclusive writers.
   Its caller booleans are prerequisites, not independent proof. It remains unwired.
4. Generic recovery readiness always leaves the clean restore drill unverified.
   The default backup worker is constructed without a production BackupProvider.
   The VPS application's own database backup is a separate operational mechanism.
5. Existing repair/release polling promises are not all drained on shutdown.
   New mutation orchestration must track shutdown, fence before side effects and
   reconcile possible writes, not copy that behavior as a guarantee.
6. Existing source reviews are data-only; static HTML releases have a narrower
   scope. Neither executes/sanitizes a real infected PHP/Node application.
7. Website inspection previously searched sibling hosted roots. The focused
   hotfix removes that breadth, fails closed on ambiguous mapping and prevents
   historical unscoped SSH evidence from becoming new actions or model context.

## Actual VPS inventory

Read-only authenticated SSH observations: **2026-10-18 15:41:56–15:44:26 UTC**,
`164.68.114.89`, hostname `vmi3643652`, root account using the existing trusted
key/alias. No exposed chat password was used. This is the VPS, not the workstation.

| Item | Observed state |
| --- | --- |
| OS/kernel/architecture | Ubuntu 24.04.5 LTS; Linux 6.8.0-139-generic; amd64 |
| CPU/memory | 8 logical CPUs; 25,199,181,824 bytes RAM; about 22.9 GB available in a short sample |
| Root filesystem | 154,894,188,544 bytes total; 11,070,603,264 available, 93% used at inventory; after candidate build about 8.7 GB / 95% used |
| Current engine | rootful Docker 29.8.2, default runc; no registered runsc |
| cgroups | v2; cpu/memory/pids/io present; dedicated unprivileged delegation **not tested** |
| User namespaces | kernel/sysctl support present; AppArmor unprivileged-userns restriction enabled |
| Missing runtime prerequisites | runsc, newuidmap/newgidmap, slirp4netns/pasta, fuse-overlayfs absent from PATH |
| Existing production | web/API/worker/PostgreSQL/Redis healthy at fa4e; Caddy/Docker/containerd/SSH/UFW active |
| Published application ports | web3000/API4000 on127.0.0.1; PostgreSQL/Redis not published |
| Resource caps | production CPU caps sum7.5vCPU and memory caps8.25GiB; caps/idle observations are not capacity reservations |
| Backup metadata | local encrypted database backup service last successful; no fresh off-server or full restore certification from this inventory |

Docker reported189 images,251 containers/7 active and146 build-cache records.
Reported reclaimable storage is **not permission to prune** and overlapping layers
must not be added together as guaranteed free space. No cleanup, installation,
daemon restart, namespace/firewall/AppArmor change or untrusted job was performed
by the inventory. New sandbox activation is blocked pending actual boundary/limit
tests and a measured storage/headroom budget. A later observation found8.58GB
available: a5GiB reserve leaves about3.21GB incremental storage.95%usage alone is
not proof that one bounded job cannot fit. Do not clean up, resize or change
hosting silently.

## Verification evidence

See [verification](SECURITY-WORKPLACE-VERIFICATION.md) for commands, exact candidate
and results. Old ledger totals and historical CI are not current passes. Inspection
and AI POST ingress were temporarily paused during the scope correction; ordinary
portal/history/monitoring remained available. Removal of that pause requires the
verified image release, not a Caddy-only workaround.

Raw secret-free audit evidence is retained outside build contexts in
`/home/nithu/codebandage-website-tools-evidence/` and on the VPS under
`/opt/codebandage/audit-website-scope-20261018/`. No secrets/dumps are copied into Git.
