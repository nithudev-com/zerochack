# Security workplace verification record

Dates: 18–19 October 2026. All timestamps below are UTC. This is a living evidence record;
pending checks are not passes. No new live customer repair has been verified.

Current tested source is `98ffec14410272e35c5a0201b2fb9552f899e1bd` on
`codex/security-workplace-vps-execution`; production remains `7279cda` in restricted
preview. The later continuation sections supersede earlier pending observations.
The complete owner specification is **not implemented**. Product admission,
exact production authority, inline plan/approval/results and tracks B–I remain
unfinished local work. The VPS-local sandbox has a separate demonstrated runtime
compatibility blocker. Neither issue is represented as a missing user password.

## Exact scope-hotfix candidate

Commit: `7279cda5188868db6848f21b2bc18a4a046fb024`.
Production Docker targets API/worker/web/tools built on the existing VPS from the
clean detached candidate checkout. Build exit0; npmci, Prisma6.12 generation,
compiled API/worker and optimized Next16.3.8 build passed. Build npm audit reported
5high development/toolchain findings; fresh release audits remain separate.
Actual runtime image asset copy includes `apps/web/public`.

## Baseline runs (source overlay, not final image certification)

Disposable VPS PostgreSQL16/Redis TLS fixture; no deployed database or customer SSH:

- source-precheck-v3: lint and all workspace typechecks PASS;844unit tests/53files
  PASS; auth integration18PASS; assessment lifecycle20PASS/1FAIL.
- The failed asynchronous background case unexpectedly returnedFAILED. Isolated
  diagnostic rerun passed1case/20skipped. No error code was established from that
  first failure, so it is not proof of a particular production root cause.
- Source audit identified possible NOWAIT contention with harmless asynchronous
  session-lastSeen writes. Candidate7279 adds bounded retries only after proven
  rolled-back authority-busy transactions, with fresh guards; no network/model/
  mutation replay. New unit and real lock/revocation integration checks are pending
  in the final exact-image suite.
- Local targeted ESLint/diff/syntax checks passed. A local Vitest run exited135
  (SIGBUS) before test execution; it is not counted as a test pass.

## Exact-image checks

- `website-scope-checks.sh 7279...`: exit0 at16:25:25UTC. Lint/allworkspace
  typechecks PASS;856unit/53files PASS;173integration PASS/1optional live scan
  SKIP;12offline profile checks PASS;7toolchain checks PASS; OpenAPI generation
  and byte comparison PASS. Exact tools image, disposable PostgreSQL/Redis.
- `website-scope-browser.sh 7279... production`: **41/41 PASS**, about2.2minutes,
  recorded around16:00UTC. Synthetic API fixtures, actual production web image.
  Includes limited coverage320/1440px, escaped reasons, historical scope warnings,
  no automatic writes, cancellation/backoff/drafts and preserved workbench.
- Development browser suite:41/41PASS,0fail/skip/flaky;212.665seconds,
  started15:56:48.698UTC. Production duration131.226seconds, started15:54:14.453UTC.
- Compiled API against private disposable TLS services: selected-domain and legacy
  action/AI-reference guards PASS; valid PostgreSQL/Redis TLS and6incorrect
  password/hostname/CA negatives PASS. Initial attempts stopped safely on a
  noninternal fixture network, then existing enabled synthetic providers. A new
  internal test network and scoped disabling of2completed-suite fixture providers
  enabled the test; production config was not changed.
- Worker on the original fixture was not started because historical queued work/
  schedules existed. A separate fresh database/RedisDB2 worker test PASS:30
  migrations, zero actionable records before/after, fresh TLS heartbeat,
  stopped/exited0 at16:45:24UTC. Original fixture history was unchanged.
- Fresh audits exit1/BLOCKED: npmproduction0; fullnpm5HIGH/0CRITICAL;
  API/worker/web43HIGH each; tools55HIGH; PostgreSQL33HIGH+1CRITICAL;
  Redis2HIGH. Source secret findings0. No suppression/waiver. PostgreSQL critical
  CVE-2025-68121 was reported in embedded Go in gosu, not the PostgreSQL TLS server;
  this is an applicability distinction, not a passed gate. Compatible braces-chain
  packages currently have no published fix; no invented override or forced major
  upgrade was applied.

Evidence logs are under `/opt/codebandage/audit-website-scope-20261018/` and the
local evidence directory named in the audit. Screenshots contain synthetic data.
Fixture/provider protocol tests are not live provider/email/payment/host evidence.

## New workflow/sandbox/repair acceptance

LangGraph compatibility spikev2 PASS: PostgreSQL verifiedTLS,3separateNode
processes, pause+persisteddecision+resume,4checkpoints,1synthetic existinggateway
call, no live provider/production mutation. Local9graph/scoped-encryption memory
protocol tests and TypeScript check PASS against pinned actual packages. First
spike failed on missing fixture membership and remains recorded, not retried.
The new Prisma-backed journal/checkpointer, real SSH repair/restore, gVisor
isolation/limit tests, PHP/WP/Node repairs and20incident benchmark are **not yet
verified**. No comparative Codex
benchmark was performed. No100-user capacity, universal malware cleanup or
production-readiness claim is made.

## Restricted-preview hotfix deployment

The exact7279revision was pushed non-force to
`codex/security-workplace-vps-execution` and confirmed with `git ls-remote`.
`main` and the upgrade branch were unchanged. A guarded release command checked
the clean fa4echeckout, exact temporary containment hash, passing test reports,
zero source-secret findings and zero active work. A fresh encrypted PostgreSQL
backup completed successfully at16:52:27UTC. No production migration was needed.

The exact images below were deployed to the existing **restricted preview**:

| Role | Immutable daemon-local image identity |
| --- | --- |
| API | `sha256:105c8c018cc9b1bd610fdd9711fe76c3d253af72c1da38dad260c9ad20fdf37d` |
| worker | `sha256:a8a51504852658964cf1c67058f70f18d6425ca1b0ba1223bfe5a1e74aa65074` |
| web | `sha256:2db8e65af58af629ae9efd99a36713b3f351d19d6adaa48bfc54cd8123d6996d` |
| tools (tested, not long-running) | `sha256:da28bd93be2abb9ab8ebfb9d2d9226d1fce32acf022144be618c03aefe45d4e2` |
| PostgreSQL | `sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb` |
| Redis | `sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` |

At16:58:08UTC all5production services were healthy; API/web published only on
loopback; origin homepage200/TLSverify0; unauthenticated synthetic inspection
POST401 rather than the temporary503. Caddy now exactly matches the existing
account-protected preview template (SHA2565675ba3f30057ae4fea4d6d14e2fcda927090f377778cbfb7e9cf56d9b4f5e61).
Live API dependency readiness reported database/Redis up.30production migrations
and15historical selected-site SSH findings remain; old unscoped evidence is
excluded from new website-only actions, not erased. An initial evidence count
used a wrong engine string and returned0; corrected actual `ssh-forensics` count
is15. No customer inspection was rerun.

Public curl: apex200/TLSverify0 to164.68.114.89; HTTPwww308toHTTPSwww and HTTPSwww308
toapex, preserving the supplied path/query. Web-reader access failed and is not
counted as verification; actual curl results are retained. Cloudflare settings,
authenticated customer/MFA/SSE and live provider/email flows were not freshly
tested by this release. Public registration remains closed and all advanced Care
flags false. This is not P1/P2 activation or a public launch.

Previous manifest:
`/opt/codebandage/releases/current-before-website-scope-7279cda5188868db6848f21b2bc18a4a046fb024.env`.
The guarded failure path restores both the prior application and its scope
containment, not an unsafe unpaused old inspector. Existing certificates, keys,
volumes, Owner/SMTP configuration and history were preserved. The new backup was
not independently restore-tested; prior same-schema disposable restore evidence
does not certify off-server disaster recovery.

## Subsequent P1/P3 work — not a production repair release

The focused audit commit `f21f03bb6fb7d55136cfefaf60f1668f0dc3d405` was pushed
without force to `codex/security-workplace-vps-execution`; `git ls-remote`
confirmed it. Neither main nor the upgrade branch was changed by that push.
Production remained pinned to7279; the new journal/schema was not deployed.

New graph/checkpointer source passed strict TypeScript and11 protocol unit tests
against the actual pinned LangGraph1.5.1/core1.2.18/checkpoint1.2.0/Zod4.5.4
packages in `/tmp/codebandage-security-compat-a89ZQDjx`. These are memory-storage
tests, not proof of the new Prisma/PostgreSQL adapter or actual repair execution.
They include checkpoint ancestry/task-order tampering and explicit saved-step
prerequisite rechecks. New PostgreSQL tests require an explicitly marked,
SHA/attempt-specific disposable database and refuse arbitrary production URLs.
Fresh full-lockfile `npm ci` was started locally while VPS access was unavailable;
its result and broader gates must be recorded after completion, not inferred.

The approved runtime attempt and interruption are recorded in
[operations](SECURITY-WORKPLACE-OPERATIONS.md). The corrected provisioning,
archive/recovery and emergency-disable helpers passed16 local Python guard tests
at17:24UTC; those are protocol/filesystem mocks, not real gVisor isolation tests.
No sandbox, paid provider or customer production mutation was verified by those
tests. Later observations below supersede the temporary reachability blocker.

## Continuation evidence, 18 October 2026, 18:18–18:40 UTC

SSH returned at18:18UTC. Read-only boot records show a shutdown at17:16UTC and a
boot at17:44UTC into6.8.0-147-generic. The implementation agent did not issue a
reboot; the reason for the interruption is not established. At18:26UTC all five
production containers were healthy, available RAM24,030,855,168bytes and root
free space10,119,688,192bytes. The detached production7279checkout was clean and
Caddy SHA256 unchanged. Public HTTPS returned200 with TLSverify0. These are
timestamped observations, not a capacity certification.

Fresh root-lockfile `npm ci --no-audit --no-fund` completed successfully with601
packages. All workspace typechecks passed after fixing the new Prisma relation
map names to match the additive SQL migration's distinct constraint names.
The first generation failure (P1012) remains evidence, not a passing check.
Fresh production npm audit:0 findings; full npm audit:5HIGH/0CRITICAL, still a
release blocker. The new31st migration has only been applied to a newly marked
local TLS-protected disposable database. Production remains at30 migrations.
New database/Redis integration and final broad checks are still in progress;
an initial wrong-password negative probe returned an unclassified error and
correctly failed the fixture instead of accepting any error as TLS/auth proof.

### Actual managed staging permission repair and recovery

At18:33–18:34UTC the reviewed source-manifest
`584c2a2e576f1ab8b57f47fceb691ceaa55f285d968e68c28e41a665f72e6d2b`
ran on the existing VPS with the pinned7279tools image. Private evidence is
`/opt/codebandage/audit-managed-target-20261018/fixture-KuRFW0Wo`.
The secret-free upload archive SHA256 is
`2dc06faee197616d9232b2c09315a275c9ce0adfa3ab2d7ca654ce308c06f4cb`.

Both real SSH variants passed, with client exit0/OOMfalse:

- Normal: pinned/key-authenticated fixed-command SSH; readonly publisher write,
  chmod, rename and hard-link refusals; encrypted recovery seal/readback/decrypt;
  exact approved0666→0664; unchanged content/ownership/mtime; replay refusal;
  separately signed recovery0664→0666; private HTTP content regression checks.
- Lost acknowledgement: actual helper mutation/journal completed, the connection
  deliberately lost its commit response, and STATUS reconciled the persisted
  verified result without reissuing COMMIT. This does not prove an arbitrary
  INTENT-only/crash state can be automatically resolved or restored.

All nine fixture containers exited0 and were retained with two private networks,
backing files, recovery and keys outside Git. Peak configured three-container
caps total0.375CPU/1.5GiB/288PIDs/48MiB tmpfs; these are not measured capacity
reservations. Root free space changed from10,119,618,560 to10,118,107,136bytes,
a1,511,424byte whole-host delta, not exact per-job accounting. During/after the
drill all five production containers stayed healthy and actual API live/ready
returned200. Public HTTPS200/TLSverify0,7279revision and Caddy hash were unchanged.

This proves only the fresh, root-provisioned `MANAGED_STATIC_PERMISSION_V1`
STAGING adapter under its trusted-host/exclusive-publisher prerequisites. It is
not customer SFTP eligibility, app-level MFA/payment/approval integration, a
production executor registration, or P2 completion. No customer website changed.

### Separate runtime attempts

The approved recovery preserved the old empty extraction stage by rename at
18:35:08UTC; nothing was deleted. The corrected128MiB decoder extracted and
verified the pinned bundle. The separate engine then failed closed because its
user could not traverse private `/opt/codebandage` to execute the runtime. Its
new user manager stopped, runtime socket was absent, and production remained
healthy. A reviewed follow-up publishes only checksum-verified executable bundle
bytes under root-owned `/usr/local/lib/codebandage-security-runtime`, retaining
private app/state permissions. The original generated config is backed up and
only an explicit, byte-exact inactive-runtime path recovery is permitted.
Nineteen local and VPS runtime guard tests passed. At18:39:09UTC the separately
provisioned engine passed actual rootless/user+network namespace and cgroupv2
checks: CPU0.25, memory1,073,741,824bytes, swap0, tasks256. The application
ancestor remained root:root0750, runtime binaries root:root0755 and socket parent
UID997 mode0700. Production remained healthy; root free9,645,613,056bytes.
No job image, gVisor job execution, broker or customer isolation claim follows
from engine provisioning. Job-level/adversarial verification is still required.

## Final source checkpoint — 19 October 2026

Source commits after the preservation baseline:
`094aae7` (dormant orchestration/journal), `908f9ef` (managed staging adapter),
`c0877a1` (guarded runtime), `289e6c7` (predeclared incident harness), and
`98ffec14410272e35c5a0201b2fb9552f899e1bd` (strict hosted CI compatibility).
There was no main/upgrade-branch reset, merge, force push or customer repair.
The root lockfile SHA256 is
`95083161f4aebc3dbd8fe35a6e60c6e13cd36d8a995da34acc6c61a5e18fcdc8`.

### Repository and disposable database checks

Environment: local Linux, Node 22.22.2, npm 10.9.7, TypeScript 5.9.3,
Prisma 6.12.0, Next 16.3.8 and installed pinned LangGraph packages. No destructive
integration suite was pointed at the deployed database.

| Executed command / mode | Actual result |
| --- | --- |
| `npm ci --no-audit --no-fund` | PASS, 601 packages; deliberate new framework lockfile only |
| `npm test -- --maxWorkers=1` on final `98ffec1` | PASS, 1,005 tests / 59 files; 0 failed, 56.888 s command duration |
| `npm run lint` | PASS, full repository |
| `npm run typecheck` | PASS, Prisma generation and all 20 workspaces |
| `npm run test:build-toolchain` | PASS, 7/7 |
| `npm run test:care-verification` | PASS, 12/12 local trusted synthetic profiles, not gVisor/customer isolation |
| `npm run test:integration -- --maxWorkers 1 --reporter json --outputFile …` | PASS, 233 tests / 0 failed / 1 explicit optional `RUN_LIVE_SCAN` skip; separate fresh TLS PostgreSQL/Redis fixture |
| `NEXT_PUBLIC_API_URL=https://codebandage.com/v1 APP_URL=https://codebandage.com NODE_OPTIONS=--max-old-space-size=1024 npm run build` | PASS, generated Prisma client, compiled API/worker and optimized production Next build; before the final test/CI-only change |
| `npm run openapi:generate` and tracked OpenAPI comparison | PASS, unchanged OpenAPI; initial sandbox IPC EPERM did not execute generation, approved retry did |
| Managed helper / codec / broker local tests | PASS, Python 21, real AES-GCM codec 6, broker protocol 11; only the earlier exact baseline manifest had a real SSH drill |
| Runtime guard/identity/recovery unit tests | PASS, 31; mocks/guards are not actual guest isolation |

Final source-gate evidence is protected outside Git at
`/home/nithu/codebandage-website-tools-evidence/final-source-gates-20261019-VGddQK`.
The results SHA256 is
`a97432cd132d82591610ff63ac50218fbc160ebcf3f4b4fe698d86751e251978`;
the 618-file non-documentation source manifest SHA256 is
`b6485145b9af219b0440d8cf4003b117618223258042343313ea4573513eca3c`.
All source hashes were identical before/after each final command. Warnings were
the existing future Vite configuration-loader warning and experimental Node SQLite.

The broader integration source archive SHA256 was
`dd75fd5cc851b5422ac7f56839c432c21a765993ef2a2c41da4e64384bd2ccc8`.
It includes 60 new real PostgreSQL/Redis cases plus 173 existing integration
cases. All 31 migrations applied to that disposable database. Correct
PostgreSQL `pg_stat_ssl` and an encrypted/authorized Redis TLS socket were verified;
wrong password, hostname and CA failed independently for both services. No TLS
validation bypass was used. Its protected summary SHA256 is
`ee0db6ba925b18653a58599af0d77bcc928b994a6a16546bce71bbff5cbd0962`.
The earlier cleanup-hook failure, Prisma error-classification failures and their
reports were retained. Only fresh fixture-owned rows were cleaned; no database
constraint was weakened. The later CI-only guard change has its own 69 focused
protocol cases and final full units; a real hosted CI run was not yet observed.

Both newly created broader legacy fixture services exited 0 at 02:11 UTC. The
earlier V4 local fixture's exact two owned containers were checked by ID, image,
scope label, private network, mounts and absence of port bindings, then stopped
at 03:17 UTC with exit 0. Its intentionally disposable tmpfs database ends on
stop; container records, source, keys, reports and networks were not deleted.
No pre-existing workstation containers were stopped. This is test cleanup, not
production backup/durability evidence.

### Browser preservation in both modes

Executed the existing `security-chat`, `security-agent-activity`,
`care-chat-request-budget` and `workbench` specs with one worker and system
Chromium, using protected one-off Playwright configs outside Git. The production
mode served the actual local optimized build with public API URL compiled in;
all API responses were synthetic intercepted fixtures. A checked-closed proxy
blocked unmatched non-loopback requests and service workers were disabled. No
production account/provider/email was exercised.

- First production preflight failed before tests because a merged configuration
  accidentally retained a second web server with the wrong working directory.
  That harness error was fixed without application changes; failed config/report
  were preserved.
- Initial full production run: 43 passed, 1 initial conversation-load timeout,
  0 skipped, 335.871 s. The trace shows successful local assets and synthetic
  care/chat responses. It does not establish a production API fault or a proven
  root cause. No timeout/assertion was relaxed.
- Same timed-out test, unchanged: three diagnostic repetitions passed
  (3.2/2.8/2.7 s).
- Final full production run: **44/44 passed**, 0 skipped/flaky, 114.927 s, started
  `2026-10-19T02:58:38.408Z`.
- Development run: **44/44 passed**, 0 skipped/flaky, 167.225 s, started
  `2026-10-19T03:02:14.095Z`. Generated `next-env.d.ts` returned to its original
  tracked contents; no unrelated generated change is committed.

Final production report SHA256:
`843ddab691e55cf6f5f2eafeb7acbe2c1d9ab0ff764d6b6662014c666116d363`.
Development report SHA256:
`025fd812c6c67c4b4e9cf9da725529ca6e535ff3c61a3e6da3847f9839107e3d`.
These protect existing behavior; they do not test unimplemented repair cards or
replace the broader portal/static-browser release gates.

### Actual runtime failure and fail-closed stop

The dedicated engine built the reviewed benign offline image
`sha256:c48a6340d3aca90fcb3bb5b29468c655112dd9ab9648c8dbe898abe41de67551`,
55,162,268 bytes, non-root UID 65532. Fresh Trivy 0.75 HIGH/CRITICAL scan returned
zero findings, exit 0, on 19 October. This is a probe image, not a new application
image or a customer-code run.

At 01:42:49 UTC, actual pinned gVisor 20261012.0 creation failed before the guest
started: `systemd error: Interactive authentication required`. The runtime source
and open upstream fix were reviewed; [ADR002](adr/002-rootless-gvisor-systemd-blocker.md)
records the decision not to bypass cgroups/polkit or silently use ordinary containers.
Only the new runtime manager/linger was stopped at 01:47:26 UTC, with evidence,
images, account, keys and created container retained. Actual per-job limits,
hostile network/mount tests, PHP/WP/Node candidate iteration and cleanup therefore
remain **NOT VERIFIED**. A pinned custom-build evaluation was offered; no owner
approval or custom runtime installation is assumed.

### Fresh audits, production preservation and remaining release gates

19 October `npm audit --json --omit=dev`: **0 findings**, exit 0.
Full `npm audit --json`: **5 HIGH / 0 CRITICAL**, exit 1, in the
braces/micromatch/fast-glob/chokidar/Tailwind development chain. The reported broad
fix includes a Tailwind major upgrade; no forced unrelated migration, fabricated
fixed version, suppression or weakened CI gate was applied. The earlier exact
deployed-image HIGH/CRITICAL findings remain blockers; no new P1 application
container build/audit or compiled-container runtime certification is claimed.

Reviewed code commit `98ffec1` archive SHA256:
`5805765ee27750c36a32e9fb8131b3f999d6d6bdc7ef3a501d9a096c6185e912`.
All 684 regular source files were extracted only after hash/path/link/size
validation into a new root-private audit directory. Trivy source-secret scan
returned **0 findings, exit 0**, at 03:07:38 UTC. Raw reports remain private under
`/opt/codebandage/audit-security-workplace-98ffec1-20261019`; snippets/credentials
were not printed. The earlier pre-CI source scan is retained separately.

Read-only production observation at 02:57 UTC: all five services healthy; API
liveness OK, dependency readiness PostgreSQL/Redis up; production checkout clean
at `7279cda`, Caddy hash unchanged, new runtime manager inactive. Public checks at
02:59 UTC: apex 200/TLS verify 0 to 164.68.114.89; HTTP and HTTPS-www 308 to the
apex preserving the synthetic path/query. Actual `/customer/register` remained
503; the different `/customer/signup` path returned a login redirect and was not
misreported as a registration endpoint. Production has **30** applied migrations
from a fixed read-only count; migration 31 was not deployed. Image identities
remain those listed above plus the unchanged PostgreSQL/Redis release manifest.

Still required: real product authority/admission and inline journey, supported
repair tracks B–I, verified VPS sandbox/broker, actual incident trials (all 24
predeclared trials currently NOT_RUN), new exact application images/audits,
broader portal/static-browser gates, authorized live-provider/MFA/payment/repair
canary and resource-appropriate recovery. No new Claude request, SMTP test,
customer scan, production mutation, DNS/TLS/proxy setting change or other-workplace
activation occurred. Owner/SMTP/provider/branding configuration remains preserved.
Existing same-disk backup evidence does not establish off-server disaster recovery.
