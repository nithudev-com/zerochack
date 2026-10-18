# Security workplace verification record

Date18October2026. All timestamps below are UTC. This is a living evidence record;
pending checks are not passes. No new live customer repair has been verified.

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
