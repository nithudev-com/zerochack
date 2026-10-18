# Website uptime monitoring

Overview places Uptime monitoring immediately after the selected website/switcher, before Tools. This is the existing bounded monitoring queue—not an AI/Care capability or website repair tool. Viewing Overview never enables monitoring or starts a probe.

History supports **Last 1 hour**, **Last 24 hours**, **7 days** and **30 days**. Hour windows are exact rolling durations, not UTC calendar days: `hours=1`/`hours=24`; existing `days=7`/`days=30` requests remain compatible. Use either hours or days, never both. Summary samples and expanded check history follow the selected range; changing the range uses a separate history cache. The one-hour chart uses twelve five-minute slots, and 24 hours uses twenty-four hourly slots. Empty slots stay unknown/grey; changing the view does not change check frequency or queue any work.

## Status and graphs

Monitoring is opt-in for any active saved public HTTP/HTTPS website; SSH, platform connectors and ownership verification are **not required** for these bounded public requests. The panel appears after adding a website, with monitoring disabled until explicitly enabled. Customers can save 5-, 15- or 60-minute schedules, pause, change their existing tenant/account MONITORING_ALERT email preference, or queue a manual check. Existing custom Owner intervals remain unchanged unless explicitly replaced. Scheduler failures leave the policy disabled. Archived, unsafe or changed targets fail closed. DNS/public-address validation, address pinning, redirect scope, TLS verification, request time/body limits and queue rate/concurrency limits remain enforced on every request. DNS failure is recorded rather than preventing opt-in. This measures externally observed website availability/response time, not internal CPU/RAM/disk or comprehensive application health. Security scans, server access and remediation retain their separate authorization/verification requirements.

HTTP 200–399 is up; 4xx/5xx, DNS-unresolved, connection failure and timeout are down for that probe. Private-target, redirect-scope, size-limit and other safety/runtime refusals are UNKNOWN, never falsely labelled downtime. Paused, pending and overdue checks have distinct neutral/warning states. Successful HTTP does not certify every website feature or remove security findings.

7/30-day graphs use UTC calendar days. The percentage is successful **observed checks** divided by conclusive up/down checks, excluding unknowns—not continuous time-weighted uptime, an SLA or coverage between checks. Grey means unknown/no conclusive samples. Windows are capped at 10,000 checks and disclose truncation. Response averages include successful checks only. Paginated history is tenant/website scoped; email delivery history is additionally recipient scoped. No raw bodies, IPs, SMTP settings or other users' recipients are exposed. Incidents use first/last-observed times, not exact outage boundaries.

Checks originate on the CodeBandage VPS, not independent regions. If this host, its database/Redis, scheduler or SMTP is unavailable, checks and alerts may not run. An off-server observer is needed for a total CodeBandage-host outage; no external service was purchased/configured.

## Alerts and recovery

Completed checks, evidence, cooldown changes and recipient-specific outbox records commit together under a website-row lock. Concurrent jobs cannot create duplicate cooldown alerts. A job left RUNNING by a crash can resume. Storage failures propagate to bounded retries rather than being labelled website downtime. Policy/target changes prevent stale probe results from being committed.

Repeated failures update evidence and suppression counts without new mail within the cooldown (critical at most 15 minutes, high at most 30). Continued failures can generate reminders after cooldown. A subsequent successful HTTP check resolves availability incidents and emits one recovery event. Unknown probes never resolve an outage. Existing security/header/integrity indicators and human escalation remain compatible; their emails use attention status, not downtime claims.

Outbox reconciliation runs at startup/every 5 seconds, recovers enqueue failures and uses stable event/job IDs. Notification/email jobs use backoff. Lost queued and stale in-flight monitoring emails reconcile with at most five actual provider attempts. Permanent failures remain visible. SMTP is not exactly-once: stable Message-ID aids deduplication but cannot prevent every duplicate after an ambiguous acknowledgement/crash. **SMTP accepted** is not guaranteed inbox delivery. Existing Owner templates, sender and recipient preferences are preserved; missing/disabled templates block delivery instead of silently succeeding.

Emails contain static green/red/neutral status graphics, recent sampled-check blocks, observed timing, fixed-origin Overview links and a CID logo. Owner subject/body templates remain in use. Arbitrary customer HTML, remote images and tracking pixels are prohibited. UI motion is restrained and respects reduced-motion; email graphics are static for client compatibility.

Immediately before a monitoring send, recipient email/verification, approval, active membership, website-read permission and current email preference are rechecked. Changed authorization/address or opt-out suppresses queued delivery. Already accepted/in-flight SMTP messages cannot be recalled.

## Acceptance

Run lint, workspace types, unit/email tests, disposable-database integrations, OpenAPI consistency and `uptime.spec.ts`/Customer Overview in development and production-image modes. Synthetic runner/browser fixtures are not live probes. Validate the compiled API/worker and Redis scheduler separately. Send at most one downtime and one recovery test to an owner-approved mailbox; inspect SMTP acceptance and request inbox confirmation. Never simulate downtime by stopping the live app.

Keep SMTP secrets in protected Owner/server storage. Report real delivery, independent observation, provider outage/recovery and load tests separately. Preserve existing keys, volumes, monitoring history, images and configuration. No schema migration is required.

## Customer pause and resume controls

In Customer → Overview, select a website, then use **Pause monitoring** next to
its uptime status. **Resume monitoring** restarts that website's checks using
the saved frequency and email preference. No SSH connection is required.

Pause is website-specific. It does not change another website's monitoring or
the account-wide monitoring-email preference. Check history, incident evidence
and email-delivery history are retained; past percentages are not a live status.
Manual **Check now** is unavailable while paused.

The database policy is authoritative: disabling is committed even if Redis is
unavailable and its repeating schedule cannot be removed. Queued checks refuse
to probe a disabled policy. An in-progress HTTP request can finish, but its
result cannot create alerts or overwrite the paused status. Policy changes and
probe-result commits use the same short website-row lock; network operations
are outside database transactions.

The email worker rechecks the current tenant-scoped website policy before
claiming a monitoring delivery and immediately before calling SMTP. Paused,
archived, missing or changed policies suppress queued/retrying monitoring mail
with `MONITORING_PAUSED_OR_CHANGED`. Outbox policy versions prevent old alerts
from being replayed after resume. Legacy records use their creation time as the
fence. Suppressed records are retained, not reset or resent. Other email types
(including password resets) are unaffected. Recipient authorization and email
preferences are still independently checked.

Pause cannot recall email already handed to SMTP or cancel a network operation
already in flight. SMTP acceptance is not proof of inbox delivery. Checks and
alert delivery also depend on the CodeBandage control-plane host being available;
this is sampled HTTP availability, not independent server-health monitoring.

For verification, use disposable databases and a capturing SMTP fixture, never
pause a customer's live monitor solely to run a test. Relevant regression suites:
`apps/api/src/auth.integration.test.ts` and
`apps/web/care-e2e/uptime.spec.ts` (development and built production web).
