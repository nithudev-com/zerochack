# Security agent verification and activation boundaries

This is an implementation/verification guide, not a production test certificate. Record the exact commit, images, environment and actual results in each release report. Do not infer a customer's scan or repair from fixture results, an animated indicator or an assistant reply.

Protocol references: [ssh2 client and host verification](https://github.com/mscdex/ssh2), [handle-based SFTP operations](https://github.com/mscdex/ssh2/blob/master/SFTP.md), and [ClamAV's documented return codes](https://github.com/Cisco-Talos/clamav/blob/main/docs/man/clamscan.1.in). The installed lockfile, not these moving documentation branches, determines dependency versions.

## Truthful progress

| Displayed phase | Evidence required | What it does not prove |
| --- | --- | --- |
| Preparing response | An outstanding chat request | A website tool, scan or repair is running |
| Connecting | Saved assessment progress confirms the SSH connection stage | Authentication succeeded or changes were approved |
| Inspecting server evidence | Saved progress confirms the fixed SSH inspection started | Complete malware coverage or a live repair |
| Checking public website | Saved progress confirms bounded public HTTP checks started | Full application testing or internal server health |
| Saving evidence | Saved progress confirms result persistence began | Results have already committed |
| Completed | Persisted successful assessment and its coverage record | The website is clean, secured or repaired |
| Inspection finished / Limited coverage | Persisted successful assessment with incomplete coverage; expandable recorded limitations | Complete coverage, a clean website or a repair |
| Action needed / failed / cancelled | Persisted block, interruption, error or cancellation | Work silently continued or was successfully rolled back |

Advance phases only from the actual request or persisted server state, never a timer or predicted sequence. A stale/unreachable progress endpoint must not keep showing confident green completion. Keep the transcript, safe errors, coverage and previous results available. The UI's possible applying/verifying presentation states do not activate repair: only a real, separately authorized repair job with retained evidence may use them. Current assessment results state `repairApplied: false`.

The assessment is bounded SSH/public-web inspection, not a general autonomous worker or shell. A real connection check is not permission for an inspection; read-only inspection consent is not permission for a mutation. The direct inspection action avoids relying on a model to interpret an ambiguous “yes.” Missing provider configuration must remain an explicit chat failure, not a fabricated model response.

## Coverage and result integrity

SSH transport must report explicit exit zero and a complete, valid versioned result. Missing/nonzero exits, absent completion markers, malformed/partial records and excessive stdout/stderr fail closed; do not convert them to zero findings. Transport/library failures must not reflect credentials or raw diagnostic content.

The fixed inspection requires the selected website's persisted canonical hostname. It selects **one exact domain-directory convention**: `$HOME/domains/<host>/{public_html,httpdocs}`, `/var/www/<host>/{public_html,html}`, `/srv/www/<host>/public_html`, or `/var/www/vhosts/<host>/httpdocs`. This is an explicit directory-name inference, not attestation of the live virtual-host configuration. It never recursively discovers the account, guesses a shared `public_html`, includes sibling domains or falls back to `/var/www`, `/srv/www` or the home folder. Missing, inaccessible, symbolic-link or ambiguous candidates produce an empty, `UNRESOLVED` filesystem result; only the already hostname-bound public HTTP checks may continue. Nonconventional roots need a future separately verified binding implementation, not a guessed path.

Root ancestors and traversal are anchored to non-following directory descriptors; children are opened relative to retained handles and identity-checked. Symlink, hardlinked/shared-file, nested hosting-directory and filesystem-boundary content is skipped with recorded limitations. Account-wide cron, processes and SSH authorization files are excluded. Full-server inspection is **not available through the website action**, even if requested in chat or an arbitrary request body. It needs a separate supported, explicitly approved scope before implementation. Host access is not authorization to inspect every hosted website.

A single Python 3 walker has a 55-second total budget, three-second fixed-candidate selection, and 30-second traversal bound of one root/40,000 entries/depth 16. Content checks cover at most 2,500 PHP/JavaScript files, 256 KiB per file and 32 MiB total. The inspection never executes website code or installs customer software. Missing Python returns no selected roots/content and `INCOMPLETE`. External ClamAV execution is withheld until a scope-preserving runner is actually verified: `NOT_RUN_SCOPE` means present but not run, while `NOT_INSTALLED` means absent. A path-based antivirus subprocess must not reintroduce sibling/symlink traversal. This release therefore does not certify antivirus coverage; bounded signature checks are not a substitute for a complete malware audit.

The API independently rejects mismatched host/root, account-global observation kinds, noncanonical paths and observations outside the exact selected root before HTTP continuation or evidence persistence. New audit/evidence records include `scope: { mode: WEBSITE, hostname, rootBinding }`. Legacy account-wide SSH evidence and old assistant reports remain stored, unchanged; they are not current website-only findings or model context. The UI shows a historical-scope warning and excluded-finding count, not a fabricated fixed status. Only newly scope-tagged assistant replies return to the conversation context; raw historical reports are still visible in retained customer history. Signed historical documents are not rewritten.

Dependencies/cache/mail/backup/log trees, inaccessible paths and exhausted budgets remain limitations. `BOUNDED` means the registered bounded checks finished, not that the website is malware-free. `INCOMPLETE` shows the actual recorded reasons and must not produce a healthy/clean assurance. The coverage disclosure is outside the live status announcement and renders text only; no retry or repair starts automatically. See [Python descriptor-relative filesystem operations](https://docs.python.org/3.12/library/os.html#files-and-directories) and [Prisma 6 JSON/null filter semantics](https://docs.prisma.io/docs/orm/v6/prisma-client/special-fields-and-types/working-with-json-fields). Disposable database tests must verify missing/null/mixed legacy evidence, not just the predicate's shape.

Public scanning currently consists of three configuration-indicator engines; the SSH inspection is an additional step, not hundreds of independent malware engines. Findings require retained observed evidence and provenance. A manually changed finding status is administrative metadata, not proof that an executor changed the website or a specific regression check passed.

Before connecting and before accepting results, recheck the exact active website URL/normalized host, running scan, saved-access digest, pinned server identity and vault account version/status/expiry. Recheck the current approved actor, active tenant membership, `scans.run` and `ai.security_context` permissions, and an unrevoked/unexpired session in the same tenant. A changed binding or revoked authority must fence old results, not publish them as a fresh success. Keep transactions short; network and SSH work stay outside database transactions.

Authentication activity can briefly update the same session row that an evidence transaction locks with `FOR SHARE NOWAIT`. Retry only the **confirmed rolled-back short database transaction** reporting `ASSESSMENT_AUTHORITY_BUSY`, at most four attempts with 25/50/100 ms waits. Recheck the original binding, stop/deadline and live authority before every attempt, retaining the same SHARE locks inside. Never retry SSH/HTTP/model work, unknown commit outcomes, raw driver errors, revocation, target drift or any other error. Long-held contention still fails closed. Disposable tests cover both harmless timestamp contention and revocation during the wait; reducing a lock or merely increasing a UI timeout is not a fix.

## Cancellation, crashes and retries

Cancellation fences subsequent work and result acceptance; an HTTP/SSH operation already sent can finish. Do not promise instantaneous remote termination, undo or restored data. A saved cancellation is not a completed repair. Review saved results before a new request; do not automatically replay an interrupted assessment or uncertain mutation.

The inspection admits at most two recent active runs, has a 150-second operation deadline and checks saved authority every two seconds. The browser sends `Prefer: respond-async` to `POST /v1/websites/:websiteId/assessment`: HTTP 202 is returned only after durable admission and current-authority validation, with `scanId`, `status: RUNNING`, `repairApplied: false` and `Preference-Applied: respond-async`. Acceptance is not completion. The bounded in-process task then updates persisted progress; browser disconnect does not approve a second run. Shutdown stops and drains tracked tasks; a crash is still interrupted/unconfirmed, not a durable automatically replayed queue job. Legacy internal tool callers retain synchronous results. Public HTTP `timeoutMs` is one budget across DNS, redirects, body reading and cleanup, not a fresh budget per hop. Cancellation stops its dedicated DNS resolver and destroys its private HTTP dispatcher; redirect bodies are cancelled before another hop. No later result is accepted after the saved cancellation fence. See [Undici dispatcher destruction versus graceful close](https://undici.nodejs.org/api/Dispatcher).

Care model jobs have their separate heartbeat/lease handling. Do not imply that this makes every assessment a durable worker job. An overdue assessment must be shown as interrupted/unconfirmed; a crashed request can require reconciliation before the active-scan uniqueness guard permits another. Never clear a running/uncertain record simply to make a new request appear to work.

## Workspace request budgets and recovery

Restricted-preview Caddy performs a real `/auth/me` check before every protected API request. Session checks therefore use a separate bounded 100/minute/IP route bucket instead of spending the shared 100/minute/IP application bucket twice. Login, reset and other stricter route limits remain enforced; neither unverified cookies nor arbitrary client headers identify a trusted user for rate-limit keys. Caddy must still sanitize forwarding headers and remain the sole published loopback proxy boundary. Do not disable rate limiting or broadly trust Cloudflare/client headers to cure a polling problem. See [Fastify rate-limit route configuration and Retry-After](https://github.com/fastify/fastify-rate-limit).

Website metadata refreshes every 30 seconds; active security progress every three seconds. Query cancellation signals reach fetch, HTTP 429 respects `Retry-After`, permanent authorization/not-found failures stop polling, and transient background errors preserve already-loaded workspaces and unsent drafts without claiming fresh verified status. Care SSE history replay coalesces into at most one latest-head refresh pair per five seconds; manually loaded history is not periodically refetched. No mutation, model request or failed message is automatically replayed. Verify these boundaries with a replay burst, loaded history, temporary 429, expired session, scope change and long readable replies at mobile/desktop sizes.

## Live security mutation remains blocked

The six security-chat tools do not mutate website files. The legacy `FINDING_MARK_IN_REMEDIATION` playbook only described a database status update; it cannot be accepted as a live repair executor. The specialist remediation route must refuse absent verified mutation execution, and a successful post-scan alone must not resolve a ticket or certify a fix. Preserve historical records instead of rewriting them as successful repairs.

The separate static-HTML candidate/single-file release workflows retain their original restricted scope and default-off flags. They are not malware cleanup, WordPress restoration, redirect repair or a general server-configuration agent.

`security-permission-target.ts` adds an **unwired, unavailable product primitive** for a single approved regular file: remove only the world-write permission bit, preserve content/ownership, verify the exact bytes/metadata, and support separately authorized restoration of that original mode. It does not expose a model tool, endpoint or customer repair button. There is no arbitrary shell, recursive chmod, content replacement, automatic retry or blind rollback. A failure once a write might have started becomes `OUTCOME_UNKNOWN`; reconcile the exact observed state before any separately approved new operation.

SFTP v3 cannot prove inode/link count or prevent hostile concurrent ancestor replacement. Before any product activation, trusted operator evidence must independently establish a single-link target and an exclusive writer/rename window covering the complete operation, including application writers. A customer checkbox, repeated metadata checks or symlink checks cannot enforce those assumptions. Targets with hostile concurrent writers remain unsupported.

Activation still requires all of the following:

- A narrow product contract, server-selected eligible target and customer-visible exact scope/diff; no arbitrary chat-supplied paths.
- Separate mutation authorization and fresh MFA, bound to the current actor, tenant, website, session, pinned account/version, content digest, metadata, operation and expiry; immediate pre-write revalidation.
- Durable encrypted recovery bytes **and metadata**, decrypted/hash-verified before the write, retained with an auditable artifact reference and recoverable existing encryption keys. A callback assertion or same-process memory round trip is not durable production recovery.
- Durable state/outcome recording, quota/budget limits, cancellation fences and observation-only reconciliation. Restoration is a new authorized operation, never an automatic uncertain-state overwrite.
- Disposable end-to-end harden, drift/refusal, interruption, recovery and application regression tests; an operator-approved bounded staging trial; dependency/container release gates; exact tested artifacts and rollback documentation.

Do not enable a repair/release flag, grant agents root or expose a Docker socket to bypass these prerequisites.

## Verification checklist

Run the applicable checks on the exact candidate, using disposable databases/loopback targets and explicitly labelled API/provider fixtures:

- `ssh-toolkit.test.ts` and `ssh-inspection-transport.test.ts`: incomplete protocol, exit/output/deadline handling, antivirus status formatting and isolated real SSH transport.
- `assessment-authority.test.ts` plus disposable assessment integration checks: target/access/version drift, revocation, scope, cancellation and post-network result fencing.
- `security-activity.test.ts`, `security-agent-activity.spec.ts`, and `security-chat.spec.ts` in development and production-image modes: server-driven phases, pending versus actual work, errors, mobile/desktop, reduced motion and accessibility.
- `specialist-mutation-gate.integration.test.ts`: status-only actions cannot create a successful repair or resolve a ticket.
- `security-permission-target.test.ts` and its disposable real-SFTP integration suite: approved permission-only change, content/metadata integrity, separate encrypted recovery, refusal and uncertain outcomes. These tests do not prove the mandatory operator assumptions on a customer server.
- Repository lint/typechecks, unit/integration suites, builds, OpenAPI consistency, production-image runtime/TLS checks and fresh dependency/container audits as required by the release guide.

Inspect exit codes and retained results, distinguish pass/fail/skip/blocked, and label mocks versus real protocols versus live providers. Do not trigger customer SSH inspections, paid model requests or real emails merely to demonstrate an animation. A whole-suite or production verification claim requires its own executed evidence; this document makes no such claim.
