# Website uptime monitoring

Overview places Uptime monitoring immediately after the selected website/switcher, before Tools. This is the existing bounded monitoring queue—not an AI/Care capability or website repair tool. Viewing Overview never enables monitoring or starts a probe.

## Status and graphs

Monitoring is opt-in and requires an active, verified website connection. Customers can save 5-, 15- or 60-minute schedules, pause, change their existing tenant/account MONITORING_ALERT email preference, or queue a manual check. Existing custom Owner intervals remain unchanged unless explicitly replaced. Scheduler failures leave the policy disabled. Archived, unverified or changed targets fail closed.

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
