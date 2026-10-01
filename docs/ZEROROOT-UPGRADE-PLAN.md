# ZeroRoot — Complete 0-to-100 Changes Plan

## Product, chat interface, animation, agent team, tools, security, architecture, and delivery

**Version:** Consolidated implementation blueprint, 23 September 2026
**Repository:** `https://github.com/nithudev-com/zerochack`
**Status:** Proposed changes, not implemented features or a security certification. Selected current repository files and official technical documentation were read; application tests were not executed for this plan.
**Supersedes:** The previous ZeroRoot AI Remediation Master Plan for the requirements discussed in this conversation.
This document preserves the requested single-chat experience, conversational access intake, customer-approved actual credential disclosure to company specialists, Claude integration, AI-led repairs, visible agent teamwork, design repairs, independent verification, customer feedback, and controlled deployment. It adds implementation contracts, motion specifications, failure handling, operational controls, and a 100-item acceptance checklist.
“Cloud model” is interpreted as Anthropic Claude, as in the previous plan. No claim is made that changing providers removes security obligations. Numeric design tokens, animation timings, concurrency settings, and performance targets below are proposed starting values, not measured results or universal requirements.

## 00. Product definition and boundaries

Build a **chat-first website care, engineering, and recovery platform**. The customer describes an issue, securely connects the approved website, sees evidence-backed findings, authorizes relevant repairs, watches the appropriate AI team prepare and verify changes, reviews a preview, approves a release, and reports remaining problems in the same conversation.
AI should perform supported engineering work, rather than merely give advice. Its automatic scope is customer-authorized source/configuration review, approved non-destructive observations, isolated functional testing, and reviewed repairs. Do not add autonomous exploitation, vulnerability reproduction against live targets, credential guessing, intrusion, destructive testing, arbitrary target discovery, or an unrestricted remote shell. Suspected serious compromise goes into evidence-preserving human-assisted incident handling.
The product is an application using foundation models, tools, policy, and versioned knowledge. Training a new foundation model is not a launch prerequisite. Do not promise perfect security, universal fixes, or superiority to another coding product without a controlled evaluation.
**Default working mode:** AI may investigate within the approved scope and prepare changes in an isolated workspace. Production changes require a matching release approval. A human specialist is available throughout, but is not mandatory before every ordinary AI repair.

## 01. Verified repository baseline and actual change points

| Observed areaEvidence read for this planChange required |                                                                                                       |                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Provider registry                                       | Gateway source registers `openai-responses`.                                                          | Add an Anthropic adapter and provider-neutral streaming/tool contracts. [R1]                          |
| Access collection                                       | Gateway instructions and customer documentation route secrets to a separate Secure Access form.       | Build secure conversational ingestion first; only then change the UI and model instructions. [R1][R2] |
| Existing AI permissions                                 | Gateway instructions prohibit claiming remediation; documented assessments are bounded and read-only. | Add a separately authorized isolated repair lifecycle, not unlimited permissions. [R1][R2]            |
| Human specialist access                                 | Remediation documentation describes temporary sessions without revealing long-lived credentials.      | Add a separately approved credential-disclosure service for named specialists. [R3]                   |
| Chat transport                                          | Customer documentation describes persisted events with authenticated SSE and Redis fan-out.           | Reuse and extend it for truthful agent and workflow activity. [R2]                                    |
| Release gates                                           | The report dated 3 September 2026 says production gates remain open.                                  | Revalidate and satisfy those gates; historical test results are not new results. [R4]                 |

The source excerpts and documentation are not a complete repository audit. The implementing assistant must reconcile documentation against executable code, migrations, current dependencies, and tests before modifying behavior.

## 02. Product surfaces and navigation

### Customer workspace

After Add Website, open the website conversation immediately. Keep a small global navigation: Websites, Notifications, Billing, and Profile. Within a website, make **Chat** the default workspace, with contextual Issues, Preview, Activity, and Access controls opening drawers or panels rather than a mandatory sequence of technical pages.
The customer should always see the selected website, selected environment, connection state, work state, and whether the live website has changed. Switching websites must switch all context together. No attachment, agent card, approval, or cached result may follow the user into another website context.

### Human specialist workspace

Retain existing job and ticket surfaces. Add approved customer/website selection, request-access actions, grant status, authenticated credential reveal/copy, activity evidence, and sanitized AI handoff summaries. Searching by customer name must search only the staff member's assigned or explicitly permitted customer directory. Use internal IDs to distinguish identical names.

### Owner control center

Add provider/model policies, role definitions, knowledge-pack versions, tool registry, connector capabilities, worker health, usage budgets, incident escalation, retention settings, and rollout flags. Preserve existing package, billing, agency, affiliate, and audit boundaries. Owner status does not silently grant customer-secret disclosure.

## 03. Chatbot visual design specification

### Overall direction

Use a calm, original ZeroRoot identity with a high-quality conversational layout. Avoid copying ChatGPT logos, assets, or proprietary branding. Avoid hacker-themed terminals, excessive neon, distracting particles, and fake security scores. Preserve the customer's existing site design when repairing it; a repair request is not permission for a redesign.

### Proposed design tokens

| TokenLight appearanceDark appearance / rule |                                             |                                                                             |
| ------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| Canvas                                      | `#F8FAFC`                                   | `#0B1020`                                                                   |
| Surface                                     | `#FFFFFF`                                   | `#121A2B`                                                                   |
| Primary text                                | `#0F172A`                                   | `#F1F5F9`                                                                   |
| Secondary text                              | `#475569`                                   | `#B7C3D5`                                                                   |
| Border                                      | `#CBD5E1`                                   | `#334155`                                                                   |
| Main action                                 | `#4F46E5` with tested foreground            | `#6366F1` with tested foreground                                            |
| Success / attention / error                 | Semantic green / amber / red                | Always paired with a label and icon; test every foreground/background pair. |
| Spacing                                     | 4, 8, 12, 16, 24, 32, 48 px                 | Same rhythm across themes.                                                  |
| Radius                                      | 10 px controls, 14 px cards, 20 px composer | Do not round every element differently.                                     |
| Type                                        | 16 px main body, 1.55–1.65 line height      | Existing licensed UI font; Tamil-capable fallback.                          |
| Touch target                                | Aim for 44 × 44 CSS px                      | Recommended design target, not a claim that this is WCAG AA's minimum.      |

These colors are a proposal, not a verified accessible palette. Test text contrast, focus indicators, disabled states, and actual component combinations. WCAG 2.2 AA has a 24 × 24 CSS-pixel minimum-target criterion with exceptions; 44 × 44 is the stricter enhanced target. [S3][S4]

### Layout rules

Desktop at approximately 1280 px and above: 232–256 px navigation, flexible center conversation with roughly 720–820 px readable text width, and an optional 300–340 px activity drawer. Do not force all three columns when the viewport is narrower.
Tablet: collapse the navigation and activity panel into accessible drawers. Mobile: one full-width conversation, a compact website header, an expandable “AI team” strip, and a bottom composer that respects safe-area insets and the on-screen keyboard. Use dynamic viewport sizing; test rotation and keyboard resize. No horizontal page scrolling at a 360 px test width.
Allow the user to keep a preview alongside chat on wide screens. On mobile, open the preview as a full-screen view with an obvious return-to-chat control. Preserve draft text in ephemeral memory during panel transitions, but not across reloads when it might contain secrets.

## 04. Chat components and interaction behavior

The component catalogue should include `WebsiteChatShell`, `WebsiteContextHeader`, `ConversationViewport`, `SecureComposer`, `MessageBlock`, `AgentTeamStrip`, `AgentActivityCard`, `AuthorizationCard`, `CredentialReceiptCard`, `FindingCard`, `RepairPlanCard`, `SpecialistRequestCard`, `VerificationCard`, `ReleaseApprovalCard`, `BeforeAfterViewer`, `ArtifactDrawer`, `FeedbackCard`, `ConnectionBanner`, and `HumanHandoffCard`. These are proposed names; reuse equivalent components.
**Composer:** multiline input, attachment button, clear Send action, keyboard instructions, accessible validation, and a secure-capture indicator inside the same composer. Enter sends where appropriate; Shift+Enter inserts a line; never submit during an IME composition event. A user can paste all access details together. Ask only for missing critical information. Do not create mandatory per-credential forms.
**Messages:** safe Markdown, code blocks with copy, readable tables, attachments represented by sanitized metadata, and a clear identity label: Customer, AI Assistant, named AI role, System, or Human Specialist. Prefer existing rendering components; a vetted `react-markdown` configuration is an option. Disable raw HTML and restrict URL protocols; arbitrary remote content must not become executable UI. [S22]
**Conversation controls:** stop text generation separately from pause/cancel work. Stopping the answer must not misleadingly imply a production action was cancelled. Sending a new requirement during a job creates a scoped change request; it does not silently mutate the currently approved plan. Editing an earlier message must not replay a release or credential grant.
**Scroll behavior:** follow new content only when the reader is near the bottom. Otherwise show a “New activity” control. Preserve position during history loading, previews, and streamed text. Keep approval buttons from jumping while a response streams.
**Attachments:** accept supported screenshots, source archives, and logs through a quarantine/validation pipeline. Enforce size, count, decompression, type, and processing limits. Strip unneeded metadata, sanitize previews, and keep suspicious content out of model input. Screenshots can also contain secrets or personal data; they need the same privacy classification. Transcripts and reports must never include raw credential attachments.
**Empty and error states:** distinguish no websites, no history, missing access, rejected authorization, invalid connection, unsupported stack, provider unavailable, paused budget, stale worker, verification failure, expired approval, no backup, and cancelled work. Every state needs a plain-language explanation and a real next action.

## 05. Animation and motion specification

Use CSS for simple transitions and one animation library for coordinated UI state. Motion for React supports reduced-motion controls; use the user preference by default and also offer a ZeroRoot “Reduce motion” preference. [S1][S2] The durations below are design proposals.

| UI eventProposed normal motionReduced-motion / failure behavior |                                                              |                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Website workspace opens                                         | 160–200 ms opacity; at most 8 px vertical travel.            | Immediate or brief fade, no travel.                        |
| New user message                                                | 120–160 ms fade.                                             | Immediate; raw secret text is never briefly rendered.      |
| New AI block                                                    | 160 ms fade of the block.                                    | No token-by-token animated typing requirement.             |
| Streamed text                                                   | Render actual received text in small batches.                | Same content; do not add a fake delay.                     |
| Agent assigned                                                  | 180 ms card entrance.                                        | Static appearance with role announcement.                  |
| Agent running                                                   | Low-amplitude status-dot pulse, about 1.6 seconds per cycle. | Static “Running” label; stop the pulse on stale heartbeat. |
| Tool starts                                                     | 160 ms row reveal with concise action name.                  | Static row.                                                |
| Agent handoff                                                   | Brief 180–220 ms highlight on the receiving card.            | Status labels only; no flying avatars.                     |
| Waiting for customer                                            | One brief focus highlight, then static.                      | Static “Needs your approval.”                              |
| Verification begins                                             | Step indicator updates from a persisted event.               | Text/number state only.                                    |
| Work completes                                                  | Single 180 ms check transition after verified completion.    | Static check and completion text.                          |
| Work fails                                                      | Immediate stable error card.                                 | Same; no shaking or strobing.                              |
| Drawer opens                                                    | 200–240 ms short slide/fade.                                 | Immediate/fade with correct focus management.              |
| Before/after comparison                                         | User-controlled slider; optional 150 ms crossfade.           | Separate labeled Before and After controls.                |
| Copy confirmation                                               | “Copied” label for a brief interval.                         | Same text announcement; no disclosure in toast.            |
| Reconnection                                                    | Static reconnecting indicator until server state returns.    | Do not animate agents as active during uncertainty.        |
| Report becomes ready                                            | 160 ms reveal after artifact registration.                   | Static file card.                                          |

Use animation to explain a state transition, not to imply work. Animate transform/opacity where practical; avoid heavy blur and large animated shadows. Stop decorative loops when the tab is hidden or the item is off-screen. Avoid sound and vibration by default. Do not generate confetti for routine security operations.
Status updates should be perceivable to assistive technology without moving focus on every event. Announce meaningful changes, not every token or heartbeat. Maintain keyboard operation, visible focus, and focus restoration on drawer close. [S5]

## 06. Visible agent-team experience

Show a compact “Your AI team” strip inside chat. Expand it into a team panel containing only assigned agents. A card displays the role icon, explicit AI label, assigned task, environment, state, start/last-activity timestamps, concise action summary, evidence links, and any blocker.
Illustrative interface only:

```
ZeroRoot / example.com                      STAGING — Live site unchanged

YOUR AI TEAM
Frontend Engineer · AI       Preparing the approved menu repair
QA Verifier · AI             Waiting for candidate build
Visual Reviewer · AI        Baseline captured

Frontend Engineer · AI
The mobile navigation overlaps the header at the tested width.
A focused layout change is being prepared in staging.

[View issue]   [View activity]   [Pause work]

RELEASE REVIEW — appears only when the real verification is complete
[Open preview]   [Review evidence]   [Approve this release]   [Request changes]
```

Use role-based icons rather than invented human identities. Do not imply that several avatars represent several human staff members. A Human Specialist card uses the verified employee display name and a separate human badge.
Agent states: `QUEUED`, `RUNNING`, `WAITING_FOR_DEPENDENCY`, `WAITING_FOR_INPUT`, `AWAITING_APPROVAL`, `VERIFYING`, `COMPLETED`, `FAILED`, `CANCELLED`, and `STALE`. Completion requires a result, not just an agent message. Show measured completed-step counts where meaningful; never use fabricated percentages or estimated finish times.
Clicking an agent reveals a filtered view of its actions and results, not hidden reasoning or private chain-of-thought. Questions to an agent go through the coordinator to preserve context and permissions. Pausing one task must surface blocked dependent tasks. Expensive deep-detail views should load on demand.

## 07. Complete customer and security flow

| StageWhat happensWhat the customer seesExit condition |                                                                                     |                                                    |                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| 1. Add website                                        | Bind a website record to the authenticated tenant.                                  | Chat opens with website context.                   | Valid website record; no implicit scan.                   |
| 2. Authorize inspection                               | Record explicit permitted targets and purpose.                                      | Short authorization card.                          | Current, scoped approval.                                 |
| 3. Collect access                                     | Ingest all provided connection details through the secure boundary.                 | Safe receipt; missing-field question if necessary. | Credential references stored; ambiguous content withheld. |
| 4. Bind connection                                    | Validate the approved connector and destination identity.                           | “Access checked” or a safe error.                  | Correct environment and capability record.                |
| 5. Baseline                                           | Snapshot approved source/configuration and known functional behavior.               | Inspection progress; live site unchanged.          | Evidence set plus limitations.                            |
| 6. Customer issue intake                              | Record expected versus observed behavior, URLs, devices, screenshots.               | “What problems have you noticed?”                  | Prioritized case scope.                                   |
| 7. Findings                                           | Review source/configuration/dependencies and relevant non-destructive observations. | Evidence-linked issues, not unsupported alarm.     | Findings triaged and deduplicated.                        |
| 8. Repair approval                                    | Propose affected files/features, validation, cost boundary, and recovery needs.     | Approve selected repairs or a scoped batch.        | Versioned repair approval.                                |
| 9. Prepare                                            | Create isolated workspace and candidate changes.                                    | Relevant AI team appears.                          | Candidate tied to source revision.                        |
| 10. Verify                                            | Independent tests, review, visual and accessibility checks as applicable.           | Passed/failed/not-tested evidence.                 | Required checks pass or escalation.                       |
| 11. Preview                                           | Show before/after, unchanged areas, unresolved items, release impact.               | Customer can report a missed issue.                | Candidate accepted for release review.                    |
| 12. Release approval                                  | Bind explicit approval to artifact digest and target.                               | Exact release card; live impact made clear.        | Current approval plus technical gates.                    |
| 13. Deploy and observe                                | Deployment service applies the artifact; health checks run.                         | Real deployment and observation state.             | Verified release or applicable recovery.                  |
| 14. Follow up                                         | Ask about remaining behavior/design concerns.                                       | “Do you notice any remaining issue?”               | Close, reopen, or human handoff.                          |
| 15. Clean up                                          | Expire grants, rotate shared credentials as applicable, enforce retention.          | Final report and access status.                    | Documented closure state.                                 |

The workflow must also model denied, expired, paused, blocked, cancelled, partially completed, and escalated outcomes. “Connection succeeded” is not “website secured.” “Patch prepared” is not “fixed in production.” “No finding from this check” is not “no compromise.”

## 08. Authorization, scope, and customer control

Separate inspection, isolated repair, production deployment, recurring monitoring, and human-secret disclosure into independently enforceable capabilities. The customer may approve related work as a clearly described batch, but one checkbox cannot approve unspecified future actions.
Do not force a separate DNS/file-verification page when an approved connection method can establish the resource binding. Preserve supported alternative verification methods and backend controls. An SSH credential is not proof of ownership or authority over all reachable services. Record the customer's authority statement, website, environment, intended work, authorization version, timestamp, expiry, and session-derived identity.
For public connectors, validate destination identity and outbound policy. For private customer infrastructure, require a separately provisioned customer connector or approved private-network boundary; do not relax platform SSRF protection globally. A trusted first SSH host key needs an explicit enrollment/verification policy; subsequent key changes stop access until reverified. Preserve TLS verification.
Make Pause, Revoke Access, Request a Specialist, and Review Activity reachable from chat. Revocation blocks future platform use immediately according to the authorization service, while already-started external operations may need reconciliation. Explain that cancellation is not an undo button.

## 09. Secure access capture inside the same chat

All incoming content must pass through an authenticated ingestion boundary before ordinary persistence, model calls, or event publication. During credential collection, treat the entire submitted message as sensitive by default. Use trusted format parsers and structural validation for mixed SSH, hosting, CMS, database, repository, and API credential details. Keep ambiguous submissions outside the normal transcript and external-model path; ask minimal follow-up questions in the same composer.
A permissive external model call followed by redaction is not an acceptable ingestion architecture. Neither is storing the message first and deleting its passwords later. Do not claim that regex, entropy checks, or any secret detector recognizes every possible secret. Provide an always-available secure-capture action in the same composer, and make that mode automatic during onboarding. Detection outside that mode is defense in depth, not a universal guarantee.
The secure receipt should state credential type, safe destination metadata, and separate storage/connection status. Mask sensitive identifiers where customer policy requires it. Never echo a password or private key into a bubble, system card, toast, report, or assistant response.
**Transport and retention:** use TLS; disable raw body logging at ingress/API/tracing/error layers; prevent sensitive requests from entering generic retry/outbox payloads; do not persist composer contents in localStorage/sessionStorage or session replay. If a sensitive buffer needs durable retry, store only an encrypted short-lived envelope in a purpose-built store. Delete abandoned envelopes through an auditable retention job. In-memory lifetime reduction is useful, but do not claim guaranteed JavaScript memory erasure.
**Vault:** authenticated encryption with distinct production key management, random nonces as required by the chosen scheme, versioned keys, and associated context binding tenant, website, credential ID and version. Keep ciphertext and key-management permissions separate. Restore drills must include the ability to recover required encryption metadata. Do not hash credentials that approved humans must later retrieve; do hash/verify application authentication secrets where appropriate.
Use brokered credential references for automated connections. Production secrets remain outside the agent-readable filesystem and model context. Deny bulk credential export through tools. Prevent secret leakage through test logs, source snapshots, `.env` files, connection URLs, browser traces, screenshot previews, and crash reports. Secret-management responsibilities include access control, auditing, rotation, revocation, and expiration. [S6][S7]

## 10. Human specialist request, reveal, and copy

An assigned employee chooses the permitted customer and website, explains the task, chooses credential types, and requests a duration. The request appears as a signed server-created card in the customer's chat; the model cannot impersonate that card with Markdown.
Show employee identity, company role, job/ticket, target environment, exact requested credential scope, reason, and expiry. Let the customer approve, deny, or request clarification. Approval creates a grant bound to the specialist, tenant, website, environment, credential IDs/versions, purpose, and expiry.
For reveal/copy, require recent specialist MFA or equivalent step-up, an active assignment, an unrevoked grant, and matching resource scope. Decrypt only the requested value through a separate server endpoint. Use non-cacheable responses, no secret-bearing URL parameters, short-lived UI state, masked defaults, and secret-free audit events. Do not grant disclosure merely because someone is an Owner or a trusted employee.
The endpoint can prove that it disclosed a secret; it cannot prove every later copy or use. UI copy telemetry is not evidence of all possible copying. Expiring a platform grant cannot recall a copied password or terminate an independently opened external session. Prefer dedicated temporary accounts; otherwise rotate the underlying credential and disable external sessions/accounts where supported. Explain this limitation before approval.
Preserve the requested ability for a specialist to use the credential in their own approved technical tools. Require managed specialist devices/workspaces and company handling policy. Do not silently email secrets or synchronize them to arbitrary external systems. New credential versions should require reauthorization unless the grant explicitly and knowingly covers rotation.

## 11. Claude gateway and model strategy

Add an `anthropic-messages` adapter behind `packages/ai-gateway`, using the official Anthropic TypeScript SDK. The official SDK provides Claude API access and tool-use support; keep its credentials server-side. [S8] The current gateway must not be switched by merely replacing a model string. [R1]
Normalize provider output to text deltas, complete validated tool requests, tool results, usage, safe errors, cancellation, and terminal outcomes. Never execute a tool from a partially streamed JSON argument. Preserve tool-call correlation IDs. Persist sanitized context and business state independently from provider conversation IDs.
Keep provider/model configuration in approved Owner settings. Record exact model identifier, provider, prompt/skill versions, tool versions, and budget for each run. Use a fast configuration for classification/customer summaries and an evaluated coding configuration for difficult repairs. A separately configured reviewer may reduce shared blind spots, but its recommendation still needs real test evidence.
Use API access intended for the application. The Claude Agent SDK is optional inside isolated workers when its sessions, hooks, subagents, and permissions reduce implementation effort. Do not install several overlapping agent frameworks. Business authorization remains outside the SDK. [S9]
Permit provider fallback only for approved availability failures under unchanged privacy, scope, budget, and safety policy. A refusal is not a trigger for provider cycling. Respect provider data-processing choices; no secret-bearing content or customer data should go to an unapproved fallback.
Treat retries as an operational design problem: choose one retry owner, distinguish safe reads from uncertain writes, persist accounting for failures as well as successes, and reconcile actual usage. Resume an application task from its checkpoint rather than blindly replaying an entire tool conversation.

## 12. Technical architecture and ownership

```
CUSTOMER / SPECIALIST / OWNER UI
                |
    Authenticated API and secure ingestion
                |
   Business authorization + grants + policy
          /                     \
 Encrypted vault             Chat/event outbox
      |                            |
 Credential broker          Authenticated SSE
      |                            |
 Approved connectors        Customer agent view
                
 Durable workflow service — authoritative execution lifecycle
                |
 Coordinator + role registry + Claude gateway
                |
 Reviewed tool registry / internal adapters / MCP host
                |
 Isolated per-job engineering and browser workers
                |
 Candidate artifacts → independent verification → preview
                |
 Explicit exact-artifact approval
                |
 Deterministic deployment/recovery service → scoped target
```

The browser never calls the model with a provider key and never connects directly to privileged MCP services. Separate the API/control plane, the credential broker, untrusted engineering execution, artifact storage, and deployment execution.
Use Temporal for new long-running repair workflows when the deployment team can operate it; its platform supports durable execution. [S10] Keep existing BullMQ jobs for established notification/scan workloads. Do not build a second competing state machine for the same operation. If introducing Temporal is deferred, the replacement must still implement persisted transitions, waiting approvals, reconciliation, cancellation, locks, and retry ownership; ephemeral in-process agent loops are insufficient.
**Sources of truth:** PostgreSQL owns identity, grants, customer decisions, artifact records, billing, and audit. The durable workflow service owns execution state. Database workflow status is a reconciled projection, not a second independent controller. Redis provides transient coordination/fan-out, not the sole permanent history. Object storage owns immutable artifact bytes referenced by the database.
Use transactional outbox messages for committed business events. All effects must carry idempotency keys. Reconcile ambiguous external outcomes before retrying; a timeout is not evidence that a remote operation did not happen. Use resource leases with fencing/version checks so a stale worker cannot write after its replacement starts.

## 13. Agent runtime, collaboration, and limits

Define 24 roles, but activate only the roles needed for a job. Start with a small operational set and add specialist roles after their evaluations pass. Multi-agent systems add coordination overhead; adding roles should be justified by measured outcomes rather than agent count. [S11]
Every `AgentDefinition` needs an ID/version, purpose, model policy, supported stacks, input/output schemas, permitted tool subset, knowledge-pack versions, allowed environments, maximum context/tool/attempt budget, completion conditions, and escalation rules. Permissions are intersected with the current job's authorization; a role definition never grants additional authority by itself.
The coordinator owns a dependency graph. Agents exchange structured task results and artifact references rather than unrestricted inter-agent conversations. Only sanitized customer-relevant summaries reach chat. Keep enough evidence to audit actions, without storing hidden reasoning as a product feature.
Proposed pilot limits: no more than three concurrent workers per website; one writer per overlapping file/resource set; up to three candidate-repair iterations for a scoped issue before escalation. These are tunable defaults, not performance promises. Set a separate total tool/token/infrastructure budget. Repeated identical errors, unsupported connectors, inconsistent evidence, budget exhaustion, and unavailable recovery plans stop the relevant work.
The coordinator cannot approve releases, grant credentials, change prices, erase audit history, install tools, or overrule access policy. A reviewer cannot self-approve a change merely by claiming confidence.

### Agent role catalogue

| IDAgentKnowledgeInputsRequired outputBoundary |                                      |                                                                          |                                                           |                                                             |                                                                   |
| --------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| A01                                           | Coordinator                          | Task dependencies, scope, uncertainty, budgets, escalation.              | Sanitized case, authorizations, capability map.           | Task graph and assignments.                                 | Plan/status tools only; no production or secrets.                 |
| A02                                           | Customer Liaison                     | Plain language, issue intake, Tamil/English communication, approval UX.  | Customer messages, verified case state.                   | Questions, understandable summaries, approval explanations. | Cannot approve on behalf of a user.                               |
| A03                                           | Environment Mapper                   | Runtime/framework inventory, deployment structure, versions.             | Approved manifests and source snapshot.                   | Versioned environment/capability map with unknowns.         | No network expansion beyond bound resources.                      |
| A04                                           | Incident Triage                      | Evidence preservation, known-good comparisons, recovery planning.        | Approved evidence and observed symptoms.                  | Human-assisted incident assessment and recovery proposal.   | No destructive cleanup, exploitation, or malware execution.       |
| A05                                           | Application Security Reviewer        | Secure coding, authentication, authorization, validation, configuration. | Provided source/configuration and applicable rules.       | Evidence-linked findings and bounded repair advice.         | Source/configuration review; no live exploit reproduction.        |
| A06                                           | Dependency and Supply-Chain Reviewer | Lockfiles, advisory relevance, compatibility, provenance.                | Manifest, lockfile, inventory, approved advisory data.    | Minimal update proposal with affected-component evidence.   | Cannot install arbitrary packages or auto-approve updates.        |
| A07                                           | API and Backend Engineer             | API contracts, data validation, business logic, error behavior.          | Approved issue, source, synthetic fixtures.               | Scoped patch and functional regression evidence.            | Isolated workspace only; no arbitrary live API mutation.          |
| A08                                           | Frontend Repair Engineer             | Components, CSS, responsive behavior, interaction state.                 | Issue, component source, design baseline.                 | Focused interface repair and preview.                       | No unrelated redesign or content changes.                         |
| A09                                           | Accessibility Reviewer               | Semantics, focus, keyboard behavior, labels, contrast.                   | Preview and component structure.                          | Automated findings plus required manual checks.             | Cannot claim full conformance from automation alone.              |
| A10                                           | Performance Engineer                 | Rendering, bundles, caching, queries, profiles.                          | Controlled baseline and candidate measurements.           | Measured optimization with comparable evidence.             | No unscheduled production load generation.                        |
| A11                                           | Data Integrity Engineer              | Schema compatibility, transactions, migrations, data preservation.       | Sanitized schema and synthetic/test data.                 | Migration assessment and tested data-change proposal.       | No automatic production deletion or arbitrary queries.            |
| A12                                           | Infrastructure Reviewer              | Deployment manifests, TLS, service health, least privilege.              | Approved configuration and narrow health observations.    | Configuration diagnosis and proposed patch.                 | No generic root shell, firewall disablement, or target discovery. |
| A13                                           | Test Author                          | Acceptance criteria, fixtures, regression design, user journeys.         | Requirements and baseline functional behavior.            | Independent test additions and expected outcomes.           | Cannot weaken existing tests to conceal a regression.             |
| A14                                           | Independent QA Verifier              | Test execution, coverage interpretation, failure analysis.               | Exact candidate artifact and registered checks.           | Actual results tied to commit, image, and environment.      | Cannot fabricate tests or silently mark skipped checks passed.    |
| A15                                           | Visual Regression Reviewer           | Stable screenshots, viewports, brand tokens, layout differences.         | Baseline, candidate screenshots, intended changes.        | Labeled before/after evidence and regression assessment.    | Baseline updates require explicit review.                         |
| A16                                           | Independent Change Reviewer          | Diff analysis, requirement fit, change impact, secure implementation.    | Patch, test results, approval scope.                      | Accept/reject recommendation with reasons and evidence.     | No self-approval and no override of release gates.                |
| A17                                           | Release and Recovery Coordinator     | Artifacts, rollout conditions, restore readiness, compatibility.         | Candidate manifest, approvals, backup evidence.           | Release/recovery proposal for the deterministic service.    | No general deployment privileges in model tools.                  |
| A18                                           | Evidence and Follow-Up Agent         | Case history, limitations, artifacts, customer feedback.                 | Verified events and user response.                        | Final report, unresolved items, or reopened issue.          | No unsupported assurance or credential disclosure.                |
| A19                                           | CMS and Commerce Engineer            | WordPress/WooCommerce or approved CMS, themes, plugins, checkout.        | Supported CMS snapshot and sandbox commerce fixtures.     | Scoped CMS repair/update candidate and test evidence.       | No real orders, refunds, bulk content rewrites, or root access.   |
| A20                                           | Integration Engineer                 | Webhooks, third-party API contracts, timeouts, idempotency.              | Redacted config and provider test fixtures.               | Integration patch and sandbox contract evidence.            | No real customer messages or live financial side effects.         |
| A21                                           | Content and Technical SEO Reviewer   | Metadata, links, canonical structure, accidental content regressions.    | Approved pages and customer content constraints.          | Content-regression findings and scoped corrections.         | No unrequested marketing rewrite or public publication.           |
| A22                                           | Observability Analyst                | Redacted logs, metrics, traces, release comparison.                      | Scoped operational telemetry.                             | Evidence of recovery or a renewed incident alert.           | Cannot disable monitoring or expose personal data.                |
| A23                                           | Knowledge Curator                    | Source quality, framework versions, playbook maintenance, evaluation.    | Reviewed public sources and approved generalized lessons. | Versioned knowledge-pack change proposal.                   | No automatic cross-customer learning or secret indexing.          |
| A24                                           | Localization and Usability Reviewer  | Tamil/English layouts, translation, input behavior, dates, usability.    | Approved UI strings and preview flows.                    | Localization and usability corrections with evidence.       | Preserve technical identifiers, legal text, and customer meaning. |

The first 18 roles retain the previous plan. Roles A19–A24 add explicit CMS/commerce, integration, content-regression, observability, knowledge-maintenance, and localization coverage. These are role definitions, not a claim that all workers already exist.

## 14. Knowledge, memory, and evaluation design

Use versioned knowledge packs instead of one huge prompt. Each pack records supported versions, trusted references, prerequisites, allowed checks, repair patterns, validation requirements, recovery constraints, known failure modes, last review, owner, and evaluation cases.
Maintain four separate stores: reviewed public technical knowledge; ZeroRoot-approved playbooks; tenant/website facts and customer design preferences; and the current case's evidence/decisions. Enforce tenant permissions before retrieval, not after generation. Scope caches and search results by tenant, website, version, and authorization. Never index secrets, production session files, or unredacted customer exports.
Start with structured metadata and framework-version-aware document search. Add vector retrieval only where evaluation shows it helps. Do not treat a popular web page or repository instruction file as trusted system policy. Store source provenance and freshness; conflicting evidence remains visible.
Agents may propose reusable lessons after a repair, but promotion into shared knowledge requires sanitization, reviewer approval, and regression evaluation. A successful outcome for one site is not proof that the same change is appropriate for another. Customer data must not silently become shared training or global memory.
Use a capability matrix per stack and connector: inspection, source collection, local build, preview, patch, deployment, backup, rotation, and recovery. Start with Git-based React/Next.js/Node and a separately validated WordPress/PHP path. Unsupported paths go to a specialist rather than speculative automation.

## 15. MCP and internal tool architecture

MCP is a tool-integration protocol, not the source of intelligence or the authorization boundary. Use the official TypeScript SDK where protocol integration is useful; keep internal typed service calls where they are simpler. Select a supported SDK/protocol pair during implementation rather than copying an old version into production. [S12]
Use logical tool domains: case/context, source/workspace, security/configuration, browser/design, quality/API, CMS/data/integration, release preparation/evidence, and operations/follow-up. These do not require eight separately deployed servers on day one. Logical permission separation is essential; physical service separation can follow risk and scale.
**Execution classes:** `C` = sanitized case/context read or scoped business proposal; `R` = approved read-only observation through a narrow broker; `W` = isolated workspace/test mutation; `D` = deterministic privileged service, not a general model tool. Even read-only content is untrusted and can contain sensitive data.
Every registered tool needs an ID/version, input and output schemas, permitted roles and environments, target-binding rules, read/write classification, cost/timeout/output limits, idempotency behavior, required authorization, egress policy, artifact policy, and audit event definition. Validate a complete tool request before execution and sanitize/validate its result before model delivery.
The model supplies task-specific arguments only. The server derives tenant, user, website, environment, job, authorization, and credential references from authenticated workflow context. Opaque IDs are not authorization. A requested resource must belong to the current context, even when its ID was guessed or returned by an untrusted source.
Local tool processes run with restricted filesystem/network permissions. Remote services require approved endpoints, authenticated identities, audience/resource binding, protected authorization flows, and minimized scopes. Do not forward unrelated bearer tokens or install arbitrary MCP servers suggested by a model. These controls address risks specifically discussed in the official MCP security guidance. [S13]

### Proposed 64-tool catalogue

The names below are ZeroRoot interface proposals, not claims that existing libraries expose identical methods. Return structured results and artifact references. Implement the subset needed for the first working repair path before expanding.

#### Case and trusted context

| IDProposed toolClassPurpose / constraint |                               |   |                                                                             |
| ---------------------------------------- | ----------------------------- | - | --------------------------------------------------------------------------- |
| T01                                      | `case_get_summary`            | C | Read the sanitized current case and unresolved questions.                   |
| T02                                      | `environment_get_manifest`    | C | Read the bound environment, source revision, and supported capabilities.    |
| T03                                      | `access_get_capabilities`     | C | Return available credential types and allowed actions, never secret values. |
| T04                                      | `case_get_authorizations`     | C | Read applicable grants and their expiry without modifying them.             |
| T05                                      | `findings_list_evidence`      | C | Retrieve persisted findings and supporting evidence references.             |
| T06                                      | `knowledge_search_reviewed`   | C | Search authorized, version-matched knowledge sources.                       |
| T07                                      | `knowledge_get_versioned_doc` | C | Read one approved document revision with provenance.                        |
| T08                                      | `case_propose_plan`           | C | Create a candidate plan; customer approval is still required.               |

#### Source and isolated workspace

| IDProposed toolClassPurpose / constraint |                              |   |                                                                          |
| ---------------------------------------- | ---------------------------- | - | ------------------------------------------------------------------------ |
| T09                                      | `source_list_files`          | R | List permitted paths in the sanitized source snapshot.                   |
| T10                                      | `source_read_sanitized`      | R | Read bounded source ranges while excluding secret-bearing files.         |
| T11                                      | `source_search_symbols`      | R | Search approved source paths and return bounded matches.                 |
| T12                                      | `source_diff_snapshot`       | R | Compare two authorized revisions and report changed paths.               |
| T13                                      | `workspace_create`           | W | Create an isolated workspace from an approved sanitized snapshot.        |
| T14                                      | `workspace_apply_patch`      | W | Apply a scoped candidate patch subject to path and size limits.          |
| T15                                      | `workspace_create_candidate` | W | Package a candidate commit/artifact without touching protected branches. |
| T16                                      | `workspace_check_conflicts`  | R | Detect changed base revisions and conflicting file ownership.            |

#### Source security and configuration review

| IDProposed toolClassPurpose / constraint |                                 |   |                                                                       |
| ---------------------------------------- | ------------------------------- | - | --------------------------------------------------------------------- |
| T17                                      | `security_review_source`        | R | Run reviewed static rules on provided source, not live exploits.      |
| T18                                      | `security_review_config`        | R | Check approved configuration against versioned defensive rules.       |
| T19                                      | `dependencies_inventory`        | R | Read manifests and lockfiles into a normalized package inventory.     |
| T20                                      | `dependencies_match_advisories` | R | Match known advisories and report applicability uncertainty.          |
| T21                                      | `secrets_scan_local`            | R | Check authorized source for secrets; return redacted locations only.  |
| T22                                      | `supplychain_inventory_image`   | R | Inspect an approved image/SBOM for known package/configuration risks. |
| T23                                      | `http_check_configuration`      | R | Observe headers/status at approved bound URLs with strict limits.     |
| T24                                      | `tls_get_summary`               | R | Read certificate/TLS configuration through a fixed scoped check.      |

#### Browser, design, and accessibility

| IDProposed toolClassPurpose / constraint |                                        |   |                                                                     |
| ---------------------------------------- | -------------------------------------- | - | ------------------------------------------------------------------- |
| T25                                      | `preview_open_bound`                   | W | Open only the job preview in a clean restricted browser context.    |
| T26                                      | `browser_get_accessibility_snapshot`   | R | Return a sanitized preview accessibility tree.                      |
| T27                                      | `browser_capture_sanitized_screenshot` | R | Capture an approved viewport while masking private regions.         |
| T28                                      | `browser_run_registered_journey`       | W | Execute a registered functional journey against isolated test data. |
| T29                                      | `design_compare_viewports`             | R | Compare approved screenshots across stable viewport configurations. |
| T30                                      | `design_compare_tokens`                | R | Identify divergence from approved design-token/component baselines. |
| T31                                      | `accessibility_run_checks`             | R | Run automated preview checks and mark manual assessment gaps.       |
| T32                                      | `content_check_links`                  | R | Review links/metadata within approved pages without broad crawling. |

#### Build, quality, API, and performance

| IDProposed toolClassPurpose / constraint |                                 |   |                                                                        |
| ---------------------------------------- | ------------------------------- | - | ---------------------------------------------------------------------- |
| T33                                      | `quality_run_lint`              | W | Execute the registered lint profile in an isolated worker.             |
| T34                                      | `quality_run_typecheck`         | W | Execute a supported static type-check profile.                         |
| T35                                      | `quality_run_unit_tests`        | W | Run registered unit tests using synthetic fixtures.                    |
| T36                                      | `quality_run_integration_tests` | W | Run controlled integration tests with test-only dependencies.          |
| T37                                      | `quality_run_build`             | W | Build the candidate using pinned, approved dependencies.               |
| T38                                      | `api_validate_contract`         | R | Validate declared API schemas and compatibility changes offline.       |
| T39                                      | `api_run_fixture_checks`        | W | Test expected API behavior in an isolated fixture environment.         |
| T40                                      | `performance_compare_runs`      | W | Compare controlled baseline/candidate profiles, not production stress. |

#### CMS, data, infrastructure, and integrations

| IDProposed toolClassPurpose / constraint |                                          |   |                                                                            |
| ---------------------------------------- | ---------------------------------------- | - | -------------------------------------------------------------------------- |
| T41                                      | `cms_get_inventory`                      | R | Read permitted CMS/theme/plugin versions through a supported connector.    |
| T42                                      | `cms_compare_trusted_files`              | R | Compare approved CMS snapshot files with trusted package artifacts.        |
| T43                                      | `cms_prepare_approved_update`            | W | Prepare an approved CMS update in staging with compatibility checks.       |
| T44                                      | `commerce_run_test_checkout`             | W | Exercise sandbox checkout; no real orders, payments, or messages.          |
| T45                                      | `database_get_schema`                    | R | Read sanitized structural schema metadata, not customer rows.              |
| T46                                      | `database_check_migration_compatibility` | W | Validate migration behavior using test databases and recovery constraints. |
| T47                                      | `infra_review_manifest`                  | R | Review provided deployment configuration without modifying infrastructure. |
| T48                                      | `integration_test_fixture`               | W | Validate integrations against mocks or approved provider test accounts.    |

#### Evidence, preview, and release preparation

| IDProposed toolClassPurpose / constraint |                             |   |                                                                             |
| ---------------------------------------- | --------------------------- | - | --------------------------------------------------------------------------- |
| T49                                      | `evidence_record_candidate` | C | Register candidate artifacts with hashes and provenance.                    |
| T50                                      | `evidence_get_artifact`     | C | Retrieve an authorized sanitized artifact or short-lived preview reference. |
| T51                                      | `review_get_change_summary` | C | Summarize the exact patch and attached verification results.                |
| T52                                      | `preview_publish_candidate` | W | Publish a private isolated preview with no production credentials.          |
| T53                                      | `recovery_get_readiness`    | C | Read actual backup/restore readiness; never fabricate a restore point.      |
| T54                                      | `release_prepare_manifest`  | C | Prepare a release proposal bound to candidate, target, and verification.    |
| T55                                      | `release_request_approval`  | C | Publish a real customer approval card, without granting approval.           |
| T56                                      | `release_get_status`        | C | Read authoritative release and post-deployment health state.                |

#### Operations, monitoring, and handoff

| IDProposed toolClassPurpose / constraint |                                     |   |                                                                                |
| ---------------------------------------- | ----------------------------------- | - | ------------------------------------------------------------------------------ |
| T57                                      | `observability_get_redacted_errors` | R | Read bounded sanitized operational errors for the approved website.            |
| T58                                      | `observability_get_health`          | R | Read registered health signals with timestamps and coverage.                   |
| T59                                      | `workflow_get_status`               | C | Read persisted workflow state, blockers, and active tasks.                     |
| T60                                      | `workflow_request_pause`            | C | Request a safe pause and report any in-flight uncertainty.                     |
| T61                                      | `specialist_request_handoff`        | C | Create a human-help request with sanitized context; no automatic secret grant. |
| T62                                      | `report_prepare_summary`            | C | Prepare a report using actual findings, verification, and limitations.         |
| T63                                      | `feedback_attach_issue`             | C | Attach customer feedback to a case and propose a reopened work item.           |
| T64                                      | `monitoring_propose_plan`           | C | Propose a scoped monitoring schedule requiring customer approval.              |

### Privileged services kept outside the general model-tool catalogue

`credential_disclose_to_specialist`, `connector_validate_binding`, `backup_create_and_verify`, `release_execute_approved`, `recovery_execute_approved`, and `credential_rotate_or_disable` are deterministic service operations. They require current authenticated grants and applicable human approvals. They are not generic AI instructions, arbitrary shell tools, or ways for an agent to approve its own work.
A tool being called “read-only” does not make its executable safe. Static analyzers, package managers, browser code, repository scripts, and test runners all execute inside the untrusted worker boundary.

## 16. Selected libraries and service responsibilities

Use reviewed, pinned versions compatible with the existing stack. Keep an owner, license review, update policy, container/image provenance, and capability test for every dependency. Avoid runtime `latest` installations.

| LayerSelectionBoundary        |                                                                                 |                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Web UI                        | Existing Next.js, React, Tailwind and shared UI package.                        | Preserve current routing/auth and avoid duplicate component frameworks.                      |
| Motion                        | Motion for React plus CSS transitions.                                          | Reduced motion and truthful state-driven animation. [S1][S2]                                 |
| Accessible primitives         | Existing primitives; Radix only where a needed accessible primitive is missing. | Focus/keyboard support still needs application testing. [S23]                                |
| Markdown                      | Existing safe renderer or reviewed `react-markdown`.                            | Raw HTML disabled, validated links, no executable tool cards from text. [S22]                |
| API validation                | Existing Fastify/Zod/OpenAPI contracts.                                         | Validate at each trust boundary, not only in the browser.                                    |
| Claude calls                  | Official `@anthropic-ai/sdk`.                                                   | Encrypted provider configuration and server-side requests. [S8]                              |
| Optional agent worker         | Claude Agent SDK in an isolated worker.                                         | No access-policy authority inside model instructions. [S9]                                   |
| Durable workflows             | Temporal for new approval/repair lifecycle.                                     | Side effects outside deterministic workflow code; explicit retry ownership. [S10]            |
| Existing queues               | BullMQ/Redis for existing workloads.                                            | Redis is not the only durable event or approval store.                                       |
| MCP                           | Official TypeScript SDK and reviewed adapters.                                  | Pin protocol compatibility and deny unknown tools. [S12][S13]                                |
| Browser/visual verification   | Playwright and fixed test environments.                                         | Registered isolated journeys; private artifacts. [S14][S15]                                  |
| Accessibility checks          | `@axe-core/playwright` plus manual review.                                      | Automated results are partial coverage, not a conformance certificate. [S16]                 |
| Source security review        | Semgrep with reviewed rules/edition.                                            | Local source analysis; check commercial features and data-processing settings. [S17]         |
| Dependency advisories         | OSV-Scanner.                                                                    | Known advisory matching; affectedness still requires interpretation. [S18]                   |
| Image/configuration inventory | Trivy where container/IaC support is required.                                  | Avoid redundant scans; normalize duplicate findings. [S19]                                   |
| Repository secrets            | Evaluated Gitleaks-compatible scanner.                                          | Redacted output only; not the conversational secret-ingestion boundary. [S20]                |
| Performance                   | Lighthouse plus existing application metrics.                                   | Stable comparable tests, not a promise of real-user speed from one score. [S21]              |
| PHP/WordPress                 | WP-CLI wrappers, PHPStan, PHPUnit, Composer audit when supported.               | Allowlisted commands in isolated environments; no broad production command access. [S24–S27] |
| Observability                 | OpenTelemetry plus existing logs and chosen backend.                            | Correlation IDs and metrics without sensitive content capture. [S28]                         |
| Persistence                   | Existing PostgreSQL/Prisma and encrypted artifact object storage.               | Scoped metadata, grants, retention, verified backup capability.                              |

Current maintenance detail: the Gitleaks repository now states that new features are frozen and future releases are security patches. Reassess the selected secret-scanner implementation during Phase 0 rather than assuming unrestricted future feature development. Do not automatically switch scanners without evaluation. [S20]
Playwright MCP can be considered behind the same browser isolation and scope policy. Its protocol is not a substitute for screenshot-based visual verification or a permission boundary. Use direct Playwright tests for deterministic acceptance checks and selective MCP interaction for investigation. [S14]

## 17. Isolation, connectors, and supported environments

Create per-job disposable engineering and browser environments. Prefer a VM/microVM or equivalently reviewed stronger isolation boundary for multi-tenant untrusted execution; a privileged shared container is unacceptable. No host Docker socket, platform database credentials, cloud metadata access, shared home directories, or production `.env` files are mounted.
Apply CPU, memory, disk, process, runtime, output-size, and network limits. Provide a sanitized source tree, minimal dependencies, and synthetic fixtures. Package install/build hooks remain untrusted. Use reviewed dependency mirrors/caches and deny unapproved outbound destinations. Scope caches so one tenant cannot poison another tenant's build.
Keep production access in a separate broker/connector with narrowly compiled operations. A customer's website may itself be compromised; do not load remote scripts or plugins into the ZeroRoot control plane. Browser contexts are fresh per job, test-only credentials are scoped, and navigation/subresource requests follow network policy.
Previews run on a separate origin without platform cookies or production credentials. Prefer short-lived authorized access over public unguessable links. Sandboxed embedding must not grant both inappropriate script execution and same-origin access. Validate any preview-to-parent messages by exact origin and narrow schema.
Publish a support matrix. For Git-based deployments, require a source revision, build contract, preview target, release connector, and recovery method. For SSH/SFTP/CMS deployments, require validated web-root mapping, consistent source/configuration capture, a supported change method, backup verification, and external drift detection. Shared hosting without a reliable staging/recovery path remains limited or human-assisted.

## 18. Repair, independent verification, release, and recovery

Preserve baseline source, relevant configuration, screenshots, expected behavior, and pre-existing test failures. Changes are scoped to the approved issue. Record intentional changes separately from accidental differences. A customer's “button broken” report should become an expected/actual behavior record and a targeted test, not a general redesign.
Independent verification runs against the exact candidate artifact. Use applicable type checks, lint, builds, unit/integration tests, registered API fixtures, critical browser journeys, accessibility checks, and visual comparisons. Keep the verifier's result authority outside the patch author's editable workspace. Do not allow deleting tests, disabling assertions, changing severity, or silently updating baselines to create an artificial pass.
Visual comparisons use fixed browser/OS/font/viewport and controlled data. Browser rendering can vary with environment, which is why stable baselines matter. [S15] Preserve manual review for keyboard/screen-reader usability and other accessibility gaps not covered by automation. [S16]
Every `ReleaseManifest` binds source revision, candidate digest, environment, plan version, verification evidence, applicable recovery evidence, authorizations, and expiry. Approval of one artifact cannot authorize a changed patch. Recheck drift, grants, budget/entitlements, and deploy locks immediately before applying changes.
A backup is not verified merely because an upload API succeeded. Establish integrity and restore-readiness evidence appropriate to the system. Periodically rehearse recovery in an isolated environment. Do not blindly restore an old database over new customer transactions; application rollback and database recovery are different operations with different business consequences.
After deployment, verify target version and critical health/journeys. On regression, stop further writes, notify the customer, and execute only a valid preapproved or newly approved recovery plan. When the remote outcome is uncertain, reconcile it before another attempt. Collect feedback and reopen individual issues without losing the earlier release history.
For suspected compromise, preserve evidence, restrict access under an approved containment plan, and notify an accountable human before consequential cleanup or recovery. Prefer trusted artifacts when justified. Never promise that a negative scan proves the absence of compromise.

## 19. Security-control matrix

| RiskRequired design controlEvidence required |                                                                                          |                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Cross-customer access                        | Session-derived tenant context, scoped lookups, composite resource bindings.             | Isolation tests across messages, tools, artifacts, grants, and streams.      |
| Credentials in chat                          | Sensitive-ingestion path before persistence/model use, encrypted vault, safe receipts.   | Synthetic-secret checks across every storage and telemetry boundary.         |
| Unapproved human disclosure                  | Named grant, assignment, recent MFA, exact credential/version, expiry/revocation.        | Allow/deny tests and secret-free disclosure audit.                           |
| Unsafe model action                          | Backend-enforced tool/environment capabilities, not prompt-only controls.                | Denials for unauthorized actions and scopes.                                 |
| Prompt injection                             | Untrusted source labels plus hard tool/data boundaries and output validation.            | Isolated adversarial-content tests that cannot alter grants or destinations. |
| Server-side request forgery                  | Reviewed destination parsing, resolved-address policy, redirect checks, egress controls. | Controlled local policy tests; no open proxy.                                |
| Malicious repository or package              | Disposable isolated worker, no host/production credentials, resource/network limits.     | Isolation tests and scanned/pinned execution images.                         |
| Unsafe preview or Markdown                   | Separate preview origin, protected sessions, safe rendering, validated links/messages.   | Browser security and cross-context tests.                                    |
| Stale or forged approval                     | Server-created cards, authenticated approval API, artifact/target/version binding.       | Replay, expiry, stale-plan, and wrong-target tests.                          |
| Duplicate or conflicting writes              | Idempotency, resource leases, fencing, single-writer policy, outcome reconciliation.     | Crash/restart/race test evidence.                                            |
| Accidental data destruction                  | Synthetic test data, exact scope, explicit approvals, verified recovery plan.            | Recovery drill and protected-operation tests.                                |
| Fabricated success                           | Authoritative tool/test/deploy evidence, honest coverage, separate result states.        | Reports validated against persisted artifacts.                               |
| Agent cost runaway                           | Reserved budgets, hard limits, bounded retries, circuit breakers.                        | Provider/worker failure and cost-limit tests.                                |
| Dependency compromise                        | Pinned reviewed packages/images, provenance, isolated installs, controlled updates.      | Update evaluation, inventory, and security review.                           |
| Privacy leakage                              | Scoped retention, redaction, access-controlled artifacts, approved provider processing.  | Data-flow review and deletion/retention tests.                               |
| Compromised specialist device                | Managed workspace/device policy, least privilege, auditing, credential rotation.         | Offboarding and incident procedures; acknowledge copied-secret limits.       |

Preserve TLS, secure session cookies, CSRF protection for state changes, exact CORS origins, content-security policy, rate limiting, input validation, and administrative MFA. Global rate limits must not substitute for per-tenant/per-user limits. Audit exports must be filtered and redacted, and append-only audit controls must be enforced by storage permissions rather than a UI label.
Data processing and retention requirements depend on customers, providers, and jurisdictions. Obtain the appropriate professional review rather than claiming regulatory compliance from this architecture. Do not use customer content for model training or shared knowledge without a separately valid arrangement.

## 20. Database and domain model plan

Inspect the Prisma schema and reuse equivalent existing models. Proposed concepts:

| DomainRecordsImportant bindings |                                                                                     |                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Resource scope                  | `WebsiteEnvironment`, `ConnectionBinding`, `CapabilityManifest`                     | Tenant, website, approved host/repository, environment, connector version. |
| Access                          | `CustomerAuthorization`, `CredentialRecord`, `CredentialVersion`, `CredentialGrant` | Actor, scope, purpose, expiry, encrypted payload metadata.                 |
| Specialist work                 | `SpecialistAssignment`, `SpecialistAccessRequest`, `DisclosureAudit`                | Named specialist, customer decision, credential versions, request status.  |
| Agent execution                 | `AgentDefinitionVersion`, `AgentRun`, `Task`, `WorkflowRunProjection`               | Role version, job, state, lease/fence, budgets, dependencies.              |
| Tools                           | `ToolDefinitionVersion`, `ToolExecution`                                            | Execution context, argument/result digests, outcome, artifact references.  |
| Repairs                         | `ChangePlanVersion`, `ChangeApproval`, `PatchArtifact`, `VerificationResult`        | Exact candidate, scope, checks, customer decision.                         |
| Release                         | `ReleaseManifest`, `ReleaseApproval`, `ReleaseAttempt`, `RecoveryEvidence`          | Artifact digest, target, prior release, technical gates.                   |
| Knowledge                       | `KnowledgeDocumentVersion`, `SkillPackVersion`, `WebsiteFact`                       | Provenance, review date, supported versions, tenant visibility.            |
| Evidence/activity               | `Artifact`, `CaseEvent`, `OutboxEvent`, `CustomerFeedback`                          | Immutable identifiers, classification, retention, event sequence.          |
| Operations                      | `BudgetReservation`, `UsageLedger`, `MonitoringPlan`, `FeatureRollout`              | Tenant limits, actual costs, entitlements, schedules, release policy.      |

Require foreign-key/resource consistency and indexes supporting tenant/website/job queries. Do not store secrets in JSON metadata, tool argument history, or workflow payloads. Persist only references to purpose-built encrypted secret records.
Use unique request/idempotency keys and optimistic version checks. Record timestamps in UTC and render the user's selected timezone. Differentiate archival of a website/case from deletion of credential material. Define retention, legal hold where applicable, erasure workflow, and backup expiration. Avoid claiming an audit hash chain alone makes records immutable.

## 21. Proposed API surface

These are target interfaces, not a claim that the repository already implements them. Keep existing compatible routes where possible. All resource IDs are checked against session-derived authorization.

| ScopeProposed endpoints |                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Chat                    | `POST /v1/websites/:websiteId/chat/ingest`; existing history and authenticated stream routes.                            |
| Authorization           | `POST /v1/websites/:websiteId/authorizations`; `POST /v1/authorizations/:id/revoke`.                                     |
| Connection              | `GET /v1/websites/:websiteId/environments`; `POST /v1/connections/:id/validate`; `GET /v1/connections/:id/capabilities`. |
| Credentials             | `GET /v1/websites/:websiteId/credentials` for metadata only; dedicated replace/revoke actions.                           |
| Human access            | `POST /v1/specialist/access-requests`; `POST /v1/access-requests/:id/approve`; `POST /v1/access-requests/:id/deny`.      |
| Human disclosure        | `POST /v1/specialist/credential-grants/:id/reveal`; response is non-cacheable, strictly scoped.                          |
| Workflows               | `POST /v1/websites/:websiteId/jobs`; `GET /v1/jobs/:id`; `POST /v1/jobs/:id/pause`; `POST /v1/jobs/:id/cancel`.          |
| Repair plan             | `GET /v1/jobs/:id/change-plan`; `POST /v1/change-plans/:id/approve`; `POST /v1/change-plans/:id/request-changes`.        |
| Agent activity          | `GET /v1/jobs/:id/agents`; use the website event stream for authorized updates.                                          |
| Preview/evidence        | `GET /v1/jobs/:id/artifacts`; authenticated preview-access exchange.                                                     |
| Release                 | `POST /v1/releases/:id/approve`; `POST /v1/releases/:id/request-changes`; `GET /v1/releases/:id`.                        |
| Feedback                | `POST /v1/jobs/:id/feedback`; `POST /v1/issues/:id/reopen`.                                                              |
| Owner controls          | Scoped provider/model/agent/tool/policy/knowledge/budget/rollout management paths.                                       |

Use typed error codes such as `AUTHORIZATION_REQUIRED`, `SECRET_CAPTURE_AMBIGUOUS`, `CONNECTION_UNVERIFIED`, `GRANT_EXPIRED`, `GRANT_REVOKED`, `UNSUPPORTED_CAPABILITY`, `VERIFICATION_FAILED`, `APPROVAL_STALE`, `BACKUP_UNAVAILABLE`, `BUDGET_EXCEEDED`, and `REMOTE_OUTCOME_UNKNOWN`. Display safe explanations; never return credential-bearing stack traces.

## 22. Real-time events and animation synchronization

Persist domain events before fan-out. Use authenticated SSE for the browser experience already present in the repository. [R2] This is a ZeroRoot UI transport choice, separate from the transport/version used for MCP.
A public activity event should carry `eventId`, `sequence`, `occurredAt`, `websiteId`, `environmentId`, `jobId`, optional `agentRunId`, `eventType`, `state`, a sanitized `summary`, and authorized `artifactRefs`. Keep sensitive server authorization metadata out of unnecessary client payloads. The server validates the subscriber's current access on connect and when relevant grants change.
Typical event names: `job.created`, `agent.assigned`, `agent.started`, `tool.started`, `tool.completed`, `agent.blocked`, `approval.required`, `approval.resolved`, `verification.completed`, `release.started`, `release.observed`, `job.paused`, `job.completed`, and `job.failed`.
Resume from an event cursor after disconnect and deduplicate by event ID/sequence. Fall back to a current-state snapshot if the cursor has expired. Browser disconnection does not cancel a job, and reconnection does not restart it. Detect stale worker heartbeats and render uncertainty instead of an endless running animation.
If cookie-authenticated same-origin SSE is used, preserve CSRF protection on state-changing APIs; a stream is not an approval channel. Do not place long-lived secrets in stream URLs. Ensure event filtering and artifact access are both tenant-scoped. Never publish raw credential-ingestion events to the ordinary event bus.

## 23. Operations, costs, commercial controls, and owner visibility

Trace model calls, tasks, tools, worker lifecycle, approvals, and releases using correlation IDs. OpenTelemetry provides vendor-neutral telemetry interfaces; choose the storage backend separately. [S28] Disable automatic capture of raw prompts, credentials, browser sessions, and unredacted tool output.
Track queue age, active jobs, stale workers, error rates, model latency, rate-limit events, verification failures, release health, credential disclosures, grant denials, customer wait states, and costs. Alerts should identify an actionable case rather than page staff for every harmless event.
Reserve a budget before dispatching work; reconcile tokens, retries, failed calls, worker compute, browser execution, storage, and selected external tool charges. Maintain a hard tenant ceiling and configurable job allowance. A customer waiting for approval must not keep expensive workers running unnecessarily. Cached results must respect tenant scope and revision freshness.
Preserve verified payment/package and entitlement gates. Offer clear boundaries such as assessment included, repair budget approved, and human service separately scoped. Do not let an AI invent prices, mark payments successful, issue refunds, or alter affiliate commissions. Existing agency grants must remain explicit; an agency cannot view another client's credentials by default.
Owner controls should expose allowed models, role/tool versions, enabled stack capabilities, worker pools, network policies, grant maximums, retention, approved integrations, and feature rollout. Production provider setup, key management, payments, backups, SMTP, and monitoring must show `NOT_CONFIGURED` until real integrations exist.

## 24. Failure handling and honest customer messaging

| SituationSystem responseCustomer-facing meaning |                                                                                     |                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Sensitive text cannot be safely classified      | Withhold it from transcript/model; retain only permitted encrypted temporary state. | Ask a minimal question inside the same composer.                    |
| Connection fails or host identity changes       | Stop connection-dependent work; request verified correction.                        | Access is not ready; no assessment success is claimed.              |
| Provider outage or quota error                  | Pause/retry according to bounded policy; preserve state.                            | AI service is unavailable; work state remains accurate.             |
| Tool timeout after a possible side effect       | Reconcile authoritative external state first.                                       | Outcome is being checked; no blind repeat.                          |
| Agent exceeds attempts/budget                   | Stop that task and prepare a human handoff.                                         | Explain what was tried and what remains unresolved.                 |
| Candidate fails tests                           | Keep production unchanged; iterate only within the approved limits.                 | Repair is not verified yet.                                         |
| Screenshot baseline differs unexpectedly        | Block visual acceptance and show the change.                                        | Ask whether the design change is intended.                          |
| Approval expires or candidate changes           | Reject the old approval and issue a fresh review.                                   | The earlier approval no longer matches the release.                 |
| Required backup is unavailable                  | Block the protected production operation.                                           | Show an actual setup/recovery prerequisite.                         |
| Deployment health regresses                     | Stop further changes and invoke applicable recovery controls.                       | Distinguish recovery proposed, executing, and verified.             |
| Customer reports a remaining problem            | Link evidence and reopen a scoped issue.                                            | Keep the case history; do not close by assertion.                   |
| Suspected serious compromise                    | Preserve evidence and escalate to an accountable human.                             | No unsupported malware-free claim or destructive automatic cleanup. |

A missing provider or unimplemented tool must be `UNAVAILABLE` or `NOT_CONFIGURED`, not a stub returning success. Do not replace errors with fake progress animations. Do not say work will continue after cancellation unless the system actually has a documented non-cancellable in-flight operation, which must be shown explicitly.

## 25. Testing and acceptance strategy

Use unit, API, database integration, browser, provider-contract, worker-isolation, and recovery tests. Test the actual production code paths with controlled fixtures. Do not use real customer secrets, payments, or destructive production operations as test data.
**Secret boundaries:** mixed credential paste; malformed/private-key input; secrets before authorization; ambiguous inputs; safe retries; attachments; normal transcript storage; model requests; tool arguments/results; exception paths; SSE; logs/traces; queue/workflow histories; database debug output; screenshots; reports; browser drafts. Verify encryption and isolation rather than only checking that the UI masks a value.
**Access and permissions:** cross-tenant IDs; wrong website/environment; unassigned specialist; approval by an unauthorized account; denied/expired/revoked grants; credential-version changes; recent-MFA expiry; owner bypass attempts; stale approvals; unchanged-versus-changed candidate digests; permission changes during a running job.
**Execution correctness:** duplicate submissions; provider streaming interruptions; malformed tool calls; unknown tools; browser refresh; disconnect/reconnect; expired event cursor; worker crash; stale lease; conflicting edits; insufficient budget; repeated repair failure; unsupported stack; tool output too large; external-operation timeout; cancellation during an approval wait and during an in-flight operation.
**Interface and motion:** 360/390/768/1280/1440 px test widths as a proposed suite; light/dark modes; 200% zoom; keyboard-only operation; screen-reader checks; reduced motion; Tamil/English wrapping; IME entry; virtual keyboard; long messages/tables; no auto-scroll hijacking; no approval-button layout shifts; no fake running state after stale heartbeat.
**Repair and release:** original expected behavior recorded; scoped patch; independent tests; baseline failures distinguished; no test weakening; stable visual comparison; exact artifact approval; environment drift; backup unavailable; recovery incompatibility; rollback drill; post-deploy regression; customer feedback reopening; monitoring expiry and customer revocation.
**Evaluation metrics:** verified repair rate, regression rate, false findings, unnecessary changes, time to the first useful result, cost per verified repair, human escalation, recovery reliability, event-display latency, and cancellation effectiveness. Set workload-specific thresholds after baseline measurement. An example UI target is p95 committed-event-to-visible-card latency below one second in a controlled same-region test; it is a proposed target, not a measured promise. Compare coding products only on identical fixtures and resource budgets.
A finite passing suite does not prove universal security. Reports must list tested environments, coverage gaps, disabled capabilities, and external provider limitations.

## 26. Repository boundaries and migration strategy

Keep the existing monorepo and reuse packages rather than rewriting all commercial and operational workflows.

| AreaIntended changes                              |                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/web`                                        | Chat shell, secure composer, real agent cards, issue/approval/preview drawers, human specialist controls.    |
| `apps/api`                                        | Secure ingestion, scope/grants, approval APIs, authenticated events, run controls, non-cacheable disclosure. |
| `apps/worker`                                     | Existing queue work; explicit integration with the new workflow/runtime boundary.                            |
| `packages/ai-gateway`                             | Anthropic adapter, normalized streaming, validated tools, accounting, provider policies.                     |
| `packages/auth`, `packages/security`              | Enforced capabilities, tenant/environment binding, output/input protections.                                 |
| `packages/audit`, `packages/database`             | Grant/disclosure records, events, new models, migrations, indexes, integrity checks.                         |
| `packages/scanner`                                | Preserve approved non-destructive engines and evidence; no arbitrary live testing expansion.                 |
| Proposed `credential-vault`                       | Encryption interface, broker references, rotation and retention lifecycle.                                   |
| Proposed `agent-runtime`, `workflows`             | Role definitions, budgets, task graph, durable execution, cancellation/recovery.                             |
| Proposed `tool-registry`, `knowledge`, `evidence` | Reviewed tool manifests, scoped retrieval, artifact provenance.                                              |
| `infrastructure` and `docs`                       | Worker isolation, network boundaries, workflow service, preview deployment, runbooks, support matrix.        |

Treat new package names as architectural boundaries, not a demand to duplicate equivalent existing code. Add backward-compatible migrations first, support mixed-version deployments, and backfill metadata deliberately. Introduce feature flags for new ingestion, Claude, agent activity, staging repairs, and production release.
Do not remove the old secure form until the new ingestion path is validated. Its emergency fallback can remain in the same chat context without becoming the mandatory customer journey. Never relax the old secret-rejection rule before the replacement boundary is active.
Review historical chat/attachment/log storage for actual secret exposure using an authorized process. When exposure is confirmed, rotate the affected credential and address stored copies under retention policy. Do not claim historical data is clean or claim a breach without evidence.
Use one source of truth for tickets, findings, and subscriptions. Migrate existing authorization records carefully; do not reinterpret a historic inspection grant as consent to disclose passwords or deploy new code.

## 27. Delivery roadmap: from foundation to release

These are ordered development gates, not elapsed-time estimates or a claim of current completion.

| GateDeliverableRequired exit evidence |                                                                                         |                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0. Baseline                           | Current code/docs/tests/provider audit; architecture decisions; capability matrix.      | Actual inventory, preserved existing controls, migration and rollback plan.              |
| 1. UI and motion contract             | Component/state catalogue, chat layout, responsive behavior, motion tokens.             | Accessible component stories and truthful event-driven prototype using labeled fixtures. |
| 2. Secure access                      | Ingestion, encrypted vault, target binding, customer permissions.                       | Secret-boundary tests and supported connection validation.                               |
| 3. Human disclosure                   | Specialist requests, chat approval, MFA, reveal/copy, revocation/rotation.              | Allow/deny tests and audited end-to-end disclosure.                                      |
| 4. Claude adapter                     | Server integration, streaming/tool normalization, usage, failures.                      | Provider contract tests and actual configured-provider smoke results.                    |
| 5. Agent runtime                      | Core roles, durable tasks, scopes, budgets, live activity.                              | Crash/reconnect/cancel behavior and no simulated status.                                 |
| 6. First repair path                  | One supported stack and one functional/UI issue.                                        | Baseline → approval → isolated patch → independent tests → preview.                      |
| 7. Controlled release                 | Real backup/recovery capability, artifact approval, deployment, health checks.          | Successful staging recovery drill and stale-approval rejection.                          |
| 8. Expand capability                  | Additional role packs, tool interfaces, CMS/API/accessibility/performance support.      | Separate evaluation evidence for each advertised capability.                             |
| 9. Production readiness               | Retention, provider configuration, monitoring, commercial boundaries, incident process. | Reviewed release checklist, independent security assessment, documented limitations.     |
| 10. Operate and improve               | Feedback, approved monitoring, model/tool upgrades, knowledge curation.                 | Ongoing measured outcomes and controlled version promotion.                              |

Implement one complete vertical path before expanding all 24 roles and 64 tools. Read-only parallel work may improve throughput; overlapping edits and production changes remain coordinated. Preview and independent verification are launch requirements, not decorations added after automation.

## 28. Final definition of done

A completed customer journey must show a real website context, valid authorization, securely ingested access, a verified connection capability, evidence-backed issue intake, an approved repair plan, real agent events, a scoped candidate patch, independent verification, a private preview, matching production approval where deployed, post-release health evidence, customer feedback, and an honest final report.
The final report separates **deployed and verified**, **verified in staging only**, **partially resolved**, **blocked**, **not tested**, and **human review needed**. Include scope, environment, before/after evidence, actual test outcomes, release identifiers, unresolved risks, and access-cleanup status. Never include secrets or a claim of perfect security.
Delivery by the implementing assistant must include changed files, migrations, new/modified routes, UI components, tools and agents actually implemented, test commands with actual output, external configuration still required, and known limitations. A plan, mock, screenshot, or green animation is not proof of a working feature.

## 29. Implementation assistant handoff

Use this document as the acceptance contract. Inspect the repository first, map existing equivalents, preserve tenant isolation and entitlement gates, and implement phase by phase. Do not rewrite unrelated working features. Do not remove controls merely to make an agent action succeed. Do not add unrestricted remote execution or automatic exploitation.
Create real migrations and providers/adapters where feasible. Keep test doubles in tests. Never report a provider as configured, a backup as verified, a test as passed, or an issue as fixed without its actual evidence. Keep sensitive material out of commits, prompts, test output, traces, and ordinary chat.
Maintain an implementation ledger mapping each requirement below to files, tests, evidence, and status. Use statuses such as `TO_VERIFY`, `IN_PROGRESS`, `IMPLEMENTED_NOT_VERIFIED`, `VERIFIED`, and `BLOCKED_EXTERNAL`. All checklist entries in this planning deliverable start as `TO_VERIFY`; this is not a statement that no existing code already satisfies part of them.

## Appendix A. 100-point implementation and acceptance checklist

Each item requires implementation evidence, not just a checked box. The separate checklist file contains the same IDs for convenient task assignment.

### Foundation and scope

| IDRequirementAcceptance evidenceInitial status |                                                                               |                                                         |           |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- | --------- |
| ZR-001                                         | Audit the current source, schema, tests, and documentation.                   | Record actual baseline and discrepancies.               | TO_VERIFY |
| ZR-002                                         | Inventory existing providers and production gates.                            | Unavailable integrations remain honestly unconfigured.  | TO_VERIFY |
| ZR-003                                         | Publish the approved product scope and unsupported operations.                | No unrestricted live exploitation or remote shell path. | TO_VERIFY |
| ZR-004                                         | Map tenant, website, environment, and resource ownership.                     | All child resources have enforced scope.                | TO_VERIFY |
| ZR-005                                         | Preserve current billing, agency, affiliate, and audit boundaries.            | Regression tests cover existing workflows.              | TO_VERIFY |
| ZR-006                                         | Create connector and stack capability matrices.                               | Advertised support matches real provider capabilities.  | TO_VERIFY |
| ZR-007                                         | Separate inspection, repair, release, monitoring, and disclosure permissions. | Independent grants and denial tests exist.              | TO_VERIFY |
| ZR-008                                         | Define exact-artifact approval and recovery rules.                            | Approval cannot apply to a changed target or artifact.  | TO_VERIFY |
| ZR-009                                         | Define migration and feature-flag rollout.                                    | Old/new versions coexist without weakening security.    | TO_VERIFY |
| ZR-010                                         | Assign owners to models, tools, policies, and release decisions.              | Versioned ownership and review records exist.           | TO_VERIFY |

### Chat design and interaction

| IDRequirementAcceptance evidenceInitial status |                                                                            |                                                         |           |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- | --------- |
| ZR-011                                         | Open the website chat immediately after adding a website.                  | Correct website/environment context is visible.         | TO_VERIFY |
| ZR-012                                         | Implement responsive desktop, tablet, and mobile layouts.                  | Specified viewport journeys have no broken overflow.    | TO_VERIFY |
| ZR-013                                         | Implement a consistent light/dark design-token system.                     | Contrast and focus combinations are tested.             | TO_VERIFY |
| ZR-014                                         | Build one multiline secure composer for natural mixed input.               | No mandatory separate credential forms.                 | TO_VERIFY |
| ZR-015                                         | Support keyboard navigation, IME entry, and mobile keyboards.              | Accidental submission and hidden composer cases pass.   | TO_VERIFY |
| ZR-016                                         | Render Markdown, code, links, and tables safely.                           | Untrusted content cannot create executable UI.          | TO_VERIFY |
| ZR-017                                         | Implement structured findings, approvals, previews, and receipts.          | Sensitive or privileged cards are server-created.       | TO_VERIFY |
| ZR-018                                         | Implement safe attachments and screenshot feedback.                        | Type, size, quarantine, privacy, and scope checks pass. | TO_VERIFY |
| ZR-019                                         | Preserve scroll position and distinguish stop-generation from cancel-work. | No scroll hijack or misleading cancellation state.      | TO_VERIFY |
| ZR-020                                         | Implement all empty, denied, unavailable, and retry states.                | Every state has accurate explanation and next action.   | TO_VERIFY |

### Animation and live agent interface

| IDRequirementAcceptance evidenceInitial status |                                                                                     |                                                         |           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- | --------- |
| ZR-021                                         | Centralize durations, easing, and motion preferences.                               | Components share documented motion tokens.              | TO_VERIFY |
| ZR-022                                         | Respect operating-system and application reduced-motion settings.                   | No essential action depends on motion.                  | TO_VERIFY |
| ZR-023                                         | Animate only after authenticated persisted work events.                             | No fabricated progress or simulated agent work.         | TO_VERIFY |
| ZR-024                                         | Create the team strip and expandable role cards.                                    | Only assigned agents appear.                            | TO_VERIFY |
| ZR-025                                         | Label AI roles separately from actual human specialists.                            | Identity is clear in chat and activity views.           | TO_VERIFY |
| ZR-026                                         | Implement queued, active, waiting, verifying, failed, cancelled, and stale visuals. | Every state matches authoritative execution state.      | TO_VERIFY |
| ZR-027                                         | Stop active animations on stale heartbeat or cancelled work.                        | A crashed worker never appears indefinitely busy.       | TO_VERIFY |
| ZR-028                                         | Implement keyboard-friendly before/after previews.                                  | Comparison works without dragging or animation.         | TO_VERIFY |
| ZR-029                                         | Announce meaningful status changes accessibly.                                      | No token-by-token screen-reader spam or focus stealing. | TO_VERIFY |
| ZR-030                                         | Test replay, reconnect, off-screen animations, and mobile panels.                   | No duplicate cards, runaway loops, or lost context.     | TO_VERIFY |

### Credential intake and vault

| IDRequirementAcceptance evidenceInitial status |                                                                                 |                                                              |           |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------- |
| ZR-031                                         | Gate sensitive access use on explicit authorization.                            | Premature or unauthorized requests cannot start work.        | TO_VERIFY |
| ZR-032                                         | Process chat through secure ingestion before persistence/model calls.           | Raw credential messages never enter ordinary records.        | TO_VERIFY |
| ZR-033                                         | Parse supported multi-credential formats and ask minimal follow-ups.            | Ambiguous inputs stay outside the transcript/model path.     | TO_VERIFY |
| ZR-034                                         | Create encrypted short-lived storage for any durable sensitive retry.           | No raw credentials in queues, caches, or workflow history.   | TO_VERIFY |
| ZR-035                                         | Implement authenticated encryption and production key management.               | Key/version/context handling is validated.                   | TO_VERIFY |
| ZR-036                                         | Bind credential versions to tenant, website, environment, and intended purpose. | Wrong-context decrypt/use is rejected.                       | TO_VERIFY |
| ZR-037                                         | Return masked receipts with distinct stored/checked status.                     | No optimistic raw-secret bubble or false connection success. | TO_VERIFY |
| ZR-038                                         | Exclude secrets from telemetry, browser drafts, reports, and artifacts.         | Synthetic-secret boundary suite passes.                      | TO_VERIFY |
| ZR-039                                         | Implement brokered connections with TLS/host identity and outbound policy.      | No open proxy or global private-network bypass.              | TO_VERIFY |
| ZR-040                                         | Implement credential rotation, revocation, retention, and recovery procedures.  | Copied-secret limits and actual cleanup are documented.      | TO_VERIFY |

### Human specialist access

| IDRequirementAcceptance evidenceInitial status |                                                                              |                                                                     |           |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------- |
| ZR-041                                         | Restrict specialist customer selection to assigned/permitted work.           | Customer-name search does not expose unrelated records.             | TO_VERIFY |
| ZR-042                                         | Create scoped access requests with reason, identity, and duration.           | Requested credential types are explicit.                            | TO_VERIFY |
| ZR-043                                         | Deliver authenticated request cards inside customer chat.                    | Model text cannot forge an actionable request.                      | TO_VERIFY |
| ZR-044                                         | Implement customer approve, deny, and clarification paths.                   | Only authorized customer decisions create grants.                   | TO_VERIFY |
| ZR-045                                         | Bind grants to specialist, resource, credential version, and expiry.         | Scope/version changes are rechecked.                                | TO_VERIFY |
| ZR-046                                         | Require recent MFA or equivalent step-up for disclosure.                     | Expired authentication cannot reveal credentials.                   | TO_VERIFY |
| ZR-047                                         | Provide real reveal/copy through a non-cacheable narrow endpoint.            | Only the selected approved secret is disclosed.                     | TO_VERIFY |
| ZR-048                                         | Audit requests, decisions, disclosure, and revocation without secret values. | Audit records distinguish server disclosure from UI copy telemetry. | TO_VERIFY |
| ZR-049                                         | Implement offboarding and customer revocation.                               | Future retrieval stops and external rotation actions are tracked.   | TO_VERIFY |
| ZR-050                                         | Provide managed specialist workspaces and clear copied-password handling.    | No silent email/export to arbitrary systems.                        | TO_VERIFY |

### Claude and multi-agent runtime

| IDRequirementAcceptance evidenceInitial status |                                                                           |                                                               |           |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- | --------- |
| ZR-051                                         | Add a real Anthropic adapter behind the existing gateway.                 | Provider contract and configured smoke tests pass.            | TO_VERIFY |
| ZR-052                                         | Normalize streaming, tool results, usage, errors, and cancellation.       | Partial tool arguments are never executed.                    | TO_VERIFY |
| ZR-053                                         | Keep provider keys and customer secrets out of browser/model exposure.    | Provider configuration is appropriately encrypted and scoped. | TO_VERIFY |
| ZR-054                                         | Version and evaluate role-specific model configurations.                  | Upgrades have measured acceptance evidence.                   | TO_VERIFY |
| ZR-055                                         | Implement the 24-role catalogue with narrow contracts.                    | Enabled roles have schemas, limits, knowledge, and tests.     | TO_VERIFY |
| ZR-056                                         | Implement coordinator task dependencies and artifact-based collaboration. | No uncontrolled inter-agent instruction loop.                 | TO_VERIFY |
| ZR-057                                         | Enforce attempt, concurrency, token, and total-budget limits.             | Runaway work stops and escalates clearly.                     | TO_VERIFY |
| ZR-058                                         | Separate agent decisions from deterministic authorization.                | Agents cannot grant themselves access or approve release.     | TO_VERIFY |
| ZR-059                                         | Implement reviewed, version-aware, tenant-scoped knowledge retrieval.     | No secret indexing or unapproved cross-customer learning.     | TO_VERIFY |
| ZR-060                                         | Implement sanctioned availability fallback and failure recovery.          | No policy-refusal bypass or blind replay of side effects.     | TO_VERIFY |

### Tools, workspaces, and connectors

| IDRequirementAcceptance evidenceInitial status |                                                                          |                                                                        |           |
| ---------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------- |
| ZR-061                                         | Register the 64 proposed interfaces with phased enablement.              | Only implemented and evaluated tools are advertised.                   | TO_VERIFY |
| ZR-062                                         | Version tool schemas and validate inputs/outputs.                        | Unknown tools and malformed requests are denied.                       | TO_VERIFY |
| ZR-063                                         | Derive execution context server-side.                                    | Models cannot select another tenant or expand target scope.            | TO_VERIFY |
| ZR-064                                         | Separate context/read tools, isolated writes, and privileged services.   | Disclosure/deployment cannot be triggered as unrestricted model tools. | TO_VERIFY |
| ZR-065                                         | Secure MCP endpoint identities, scopes, transports, and egress.          | No arbitrary server install or token passthrough.                      | TO_VERIFY |
| ZR-066                                         | Provide disposable isolated engineering/browser workers.                 | No host socket, production secrets, or shared tenant state.            | TO_VERIFY |
| ZR-067                                         | Treat dependency installs, tests, and repository scripts as untrusted.   | Pinned artifacts and network/resource limits are enforced.             | TO_VERIFY |
| ZR-068                                         | Implement controlled source snapshots and narrow patch application.      | Secret files and out-of-scope paths are excluded.                      | TO_VERIFY |
| ZR-069                                         | Provide protected previews and stable browser evidence.                  | Preview origin and cookies are separated from the platform.            | TO_VERIFY |
| ZR-070                                         | Serialize conflicting writes with leases/fencing and reconcile outcomes. | Stale workers and duplicate operations cannot corrupt work.            | TO_VERIFY |

### Repair, verification, and production release

| IDRequirementAcceptance evidenceInitial status |                                                                     |                                                                    |           |
| ---------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ | --------- |
| ZR-071                                         | Record expected behavior and a versioned baseline.                  | Findings include evidence and coverage limitations.                | TO_VERIFY |
| ZR-072                                         | Ask for customer-observed issues and prioritize agreed work.        | Reported design/functionality problems remain traceable.           | TO_VERIFY |
| ZR-073                                         | Present a scoped repair plan with cost and validation boundaries.   | Customer approval does not authorize unrelated changes.            | TO_VERIFY |
| ZR-074                                         | Prepare changes in staging with synthetic/sanitized data.           | No real payments, messages, or uncontrolled side effects.          | TO_VERIFY |
| ZR-075                                         | Independently verify the exact candidate.                           | Actual lint/build/test/browser evidence is attached.               | TO_VERIFY |
| ZR-076                                         | Protect tests and visual baselines from acceptance manipulation.    | Deleting checks or silently replacing baselines blocks acceptance. | TO_VERIFY |
| ZR-077                                         | Provide before/after preview and request-changes loop.              | Unresolved customer feedback can reopen work.                      | TO_VERIFY |
| ZR-078                                         | Verify applicable backup and recovery readiness.                    | Missing or invalid recovery evidence blocks protected release.     | TO_VERIFY |
| ZR-079                                         | Require exact-artifact release approval and immediate drift checks. | Stale approvals and incompatible environments are rejected.        | TO_VERIFY |
| ZR-080                                         | Deploy through the deterministic service and verify health.         | Recovery and closure states reflect authoritative outcomes.        | TO_VERIFY |

### Data, events, operations, and administration

| IDRequirementAcceptance evidenceInitial status |                                                                          |                                                                   |           |
| ---------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------- |
| ZR-081                                         | Add/reuse domain models and backward-compatible migrations.              | Foreign keys, indexes, and data backfills are tested.             | TO_VERIFY |
| ZR-082                                         | Implement transactional outbox and durable workflow projections.         | State ownership is clear and recoverable.                         | TO_VERIFY |
| ZR-083                                         | Implement authenticated resumable SSE with event deduplication.          | Reconnect cannot leak context or restart a job.                   | TO_VERIFY |
| ZR-084                                         | Protect artifacts, logs, reports, and preview access.                    | Every retrieval rechecks resource authorization.                  | TO_VERIFY |
| ZR-085                                         | Implement secret-free telemetry and actionable alerts.                   | Operators can investigate without raw sensitive payloads.         | TO_VERIFY |
| ZR-086                                         | Reserve and reconcile full job cost.                                     | Failures/retries and infrastructure usage count toward ceilings.  | TO_VERIFY |
| ZR-087                                         | Preserve verified commercial and agency/affiliate policies.              | AI cannot fabricate prices, payments, or entitlements.            | TO_VERIFY |
| ZR-088                                         | Implement owner policies and staged feature rollout.                     | Provider/tool changes are versioned and auditable.                | TO_VERIFY |
| ZR-089                                         | Implement retention, deletion, archival, and historical-secret response. | Rules apply to primary data, artifacts, and backups as designed.  | TO_VERIFY |
| ZR-090                                         | Implement approved monitoring, incident escalation, and emergency stop.  | Schedules expire/revoke and consequential actions are controlled. | TO_VERIFY |

### Quality, launch, and improvement

| IDRequirementAcceptance evidenceInitial status |                                                                                |                                                                   |           |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------- |
| ZR-091                                         | Run unit, API, integration, browser, and provider-contract suites.             | Actual commands/results are recorded.                             | TO_VERIFY |
| ZR-092                                         | Run secret-boundary and cross-tenant verification.                             | Negative authorization and privacy cases pass.                    | TO_VERIFY |
| ZR-093                                         | Run isolated untrusted-content and tool-policy tests.                          | Remote instructions cannot override access or destination policy. | TO_VERIFY |
| ZR-094                                         | Run worker crash, retry, duplicate, race, and cancellation tests.              | Ambiguous outcomes reconcile safely.                              | TO_VERIFY |
| ZR-095                                         | Run responsive, reduced-motion, localization, and manual accessibility checks. | Critical chat/approval workflows remain usable.                   | TO_VERIFY |
| ZR-096                                         | Run backup/recovery, deployment-regression, and stale-approval drills.         | Recovery evidence exists before protected production use.         | TO_VERIFY |
| ZR-097                                         | Benchmark repair quality, regressions, latency, and cost.                      | Claims are limited to actual measured workloads.                  | TO_VERIFY |
| ZR-098                                         | Complete production provider and infrastructure readiness review.              | No fabricated integration, backup, or health status.              | TO_VERIFY |
| ZR-099                                         | Deliver customer reporting, human handoff, and operator runbooks.              | Limitations and unresolved issues are explicit.                   | TO_VERIFY |
| ZR-100                                         | Release one verified end-to-end journey and expand by evidence.                | Each enabled capability meets its own acceptance gate.            | TO_VERIFY |

## Appendix B. Requirement coverage map

| Requirement from the conversationWhere specified                 |                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| One ChatGPT-style conversation after adding a website            | Sections 02–04 and 07; original ZeroRoot branding. |
| Chatbot colors, typography, responsive layout, and components    | Sections 03–04.                                    |
| Chat animations and accessible motion                            | Section 05 and checklist ZR-021–ZR-030.            |
| Beautiful visible AI-agent cards and role animations             | Sections 05–06 and 22.                             |
| Natural bulk credential paste without separate forms             | Sections 04, 08–09.                                |
| Secrets stored outside ordinary chat/model context               | Sections 09, 17, 19, 25.                           |
| Company specialists receive actual passwords only after approval | Section 10 and checklist ZR-041–ZR-050.            |
| Claude provider migration                                        | Section 11 and checklist ZR-051–ZR-054.            |
| AI performs supported fixes, including design and API issues     | Sections 07, 13, 18 and tool groups 2–6.           |
| More specialist agents and their knowledge                       | Sections 13–14: A01–A24.                           |
| MCP architecture and additional technical tools                  | Sections 15–16: T01–T64.                           |
| Structured website checkup, evidence, and user questions         | Sections 07, 18, 24.                               |
| User approval before live changes and feedback after fixes       | Sections 07–08, 18, 21.                            |
| Strong security, tenant isolation, and secure specialist access  | Sections 08–10, 15, 17, 19.                        |
| Technical architecture, models, APIs, live events                | Sections 12, 20–22, 26.                            |
| Fast work without uncontrolled agent cost or loops               | Sections 11–13, 23, 25.                            |
| Final developer roadmap and no missing completion criteria       | Sections 27–29 and all 100 checklist items.        |

## Appendix C. Sources and provenance

Repository files below were read through the connected GitHub tool. Technical references were checked against official project/provider documentation. Repository reports describe their own historical state; they are not independent current certification. Proposed implementation choices in this document are recommendations, not requirements imposed by all of these sources.

### Repository

[R1] AI gateway source — `https://github.com/nithudev-com/zerochack/blob/main/packages/ai-gateway/src/index.ts`
Reviewed source excerpt: lines 1–92. Returned file SHA: `7e30d07f545ba4a2b518fc2472b3c1a2ac603fb7`.
[R2] Customer portal documentation — `https://github.com/nithudev-com/zerochack/blob/main/docs/CUSTOMER-PORTAL.md`
Returned file SHA: `22cc53df8aecc8abb6d24351bcd9216c4131bd5d`.
[R3] Remediation documentation — `https://github.com/nithudev-com/zerochack/blob/main/docs/REMEDIATION.md`
Returned file SHA: `3dd62956494f164fc2211d6d7b66a66802c9b2a1`.
[R4] Release report — `https://github.com/nithudev-com/zerochack/blob/main/docs/RELEASE-REPORT.md`
Report date: 3 September 2026. Returned file SHA: `502a6409ed933b5a01a773acdc296e46ce300a99`.

### Official technical references

[S1] Motion accessibility — `https://motion.dev/docs/react-accessibility`
[S2] Motion reduced-motion configuration — `https://motion.dev/docs/react-motion-config`
[S3] W3C WCAG 2.2 target size minimum — `https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum`
[S4] W3C enhanced target size — `https://www.w3.org/WAI/WCAG21/Understanding/target-size`
[S5] W3C status messages — `https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html`
[S6] OWASP secrets management — `https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html`
[S7] Claude secure agent deployment — `https://code.claude.com/docs/en/agent-sdk/secure-deployment`
[S8] Anthropic TypeScript SDK — `https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript`
[S9] Claude Agent SDK overview — `https://code.claude.com/docs/en/agent-sdk/overview`
[S10] Temporal documentation — `https://docs.temporal.io/`
[S11] Anthropic, Building effective agents — `https://www.anthropic.com/engineering/building-effective-agents`
[S12] Official MCP TypeScript SDK — `https://github.com/modelcontextprotocol/typescript-sdk`
[S13] MCP security best practices — `https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices`
[S14] Playwright MCP — `https://playwright.dev/docs/getting-started-mcp`
[S15] Playwright visual comparisons — `https://playwright.dev/docs/next/test-snapshots`
[S16] Playwright accessibility testing — `https://playwright.dev/docs/accessibility-testing`
[S17] Semgrep Code overview — `https://docs.semgrep.dev/semgrep-code/overview`
[S18] OSV-Scanner — `https://google.github.io/osv-scanner/`
[S19] Trivy documentation — `https://trivy.dev/docs/latest/guide/`
[S20] Gitleaks repository and maintenance notice — `https://github.com/gitleaks/gitleaks`
[S21] Lighthouse overview — `https://developer.chrome.com/docs/lighthouse/overview`
[S22] React Markdown — `https://github.com/remarkjs/react-markdown`
[S23] Radix accessibility — `https://www.radix-ui.com/primitives/docs/overview/accessibility`
[S24] WP-CLI command reference — `https://developer.wordpress.org/cli/commands/`
[S25] PHPStan — `https://phpstan.org/user-guide/getting-started`
[S26] PHPUnit manual, example version to match against supported PHP — `https://docs.phpunit.de/en/12.5/`
[S27] Composer audit — `https://getcomposer.org/doc/03-cli.md#audit`
[S28] OpenTelemetry overview — `https://opentelemetry.io/docs/what-is-opentelemetry/`

## Closing implementation rule

Build and verify one complete customer journey before expanding the catalogue. The target is a dependable website-repair experience with visible AI teamwork, not a collection of animated agents. Every enabled feature must have an enforced permission boundary, an actual implementation, a tested failure path, and honest customer-facing evidence.