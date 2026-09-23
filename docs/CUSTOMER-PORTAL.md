# Customer portal and website workspace

Phase 2 adds the authenticated customer surface at `/customer`. Its sidebar intentionally contains only Overview, My Websites, Subscription, Billing, Notifications, and Profile. A website workspace has a focused six-item journey navigation and keeps its case chat available from every view.

## Data integrity and tenant isolation

All customer API queries obtain `tenantId` from the server-side session. Client headers, query parameters, and submitted tenant identifiers are never used as authorization context. Website and child-resource lookups always combine the session tenant ID with the requested website ID. An inaccessible or guessed UUID returns `404`, preventing resource enumeration. Composite database foreign keys also require every website child record and optional finding/ticket reference to carry the same tenant and website IDs.

Websites use an archive lifecycle. `DELETE /v1/websites/:websiteId` sets `ARCHIVED`, records `archivedAt`, and pauses monitoring and backups; it does not destroy security history. Changing a URL returns connection state to `PENDING`.

Ownership uses one-hour DNS TXT, HTTP-file, or secure connector-token challenges. Only a keyed SHA-256 hash is stored. The raw challenge is returned once, and successful proof is followed by an SSRF-hardened connection test before privileged scanning is allowed.

## Honest states and queues

Posture starts as `UNKNOWN`; monitoring and backups start as `NOT_CONFIGURED`. Monitoring enablement is `PENDING` until a worker confirms it. Scans, monitoring changes, backups, and reports are persisted honestly and submitted to their existing BullMQ queues. The customer UI does not infer successful processing. Empty subscription, invoice, finding, notification, scan, ticket, report, and chat collections are rendered as empty states.

## Guided customer workflow

The website workspace presents five stages: website onboarding, encrypted SSH access or an immediate General Live Help handoff, a chat-oriented security assessment, website-specific package and cost presentation, and specialist remediation. The assistant opens automatically, provides hosting-dashboard guidance, and rejects credential-like content submitted through ordinary chat. Passwords and private keys are accepted only by the encrypted access form. SSH validation resolves only public targets, authenticates with the server-side decrypted credential, and pins the first verified host-key fingerprint; later key changes fail closed.

The assessment toolkit runs a fixed, bounded, read-only command that inspects file names and permission metadata beneath common web roots. It never accepts model-generated shell commands and never reads file contents. Those server observations are combined with the existing safe HTTP engines, persisted as authoritative findings, and supplied to the AI only as sanitized context. The assistant uses the latest owner-published package versions and verified payment state as authoritative data. The finding-level specialist handoff returns `PAYMENT_REQUIRED` until a successful payment (or an active zero-cost package) is recorded.

## Real-time chat

Messages are persisted before delivery and streamed through authenticated Server-Sent Events. Redis pub/sub fans persisted events out across API replicas; tests use an in-process transport. Types are `CUSTOMER`, `AI`, `SPECIALIST`, and `SYSTEM`, with optional finding and ticket foreign keys. The UI always labels AI as “AI Assistant” and uses a specialist's stored display name for human specialist messages.

## API summary

- `GET /v1/customer/overview`
- `GET|POST /v1/websites`
- `GET|PATCH|DELETE /v1/websites/:websiteId`
- `POST /v1/websites/:websiteId/verification`
- `POST /v1/websites/:websiteId/verification/check`
- `POST /v1/websites/:websiteId/scans|backups|reports|tickets`
- `PATCH /v1/websites/:websiteId/monitoring`
- `GET|POST /v1/websites/:websiteId/chat`
- `GET /v1/websites/:websiteId/chat/stream`
- `GET /v1/customer/subscription|billing|notifications`

## Security tests

The integration suite uses two real tenants. It attempts cross-tenant reads, edits, archive operations, scans, chat access, altered query parameters, and forged tenant headers. Each inaccessible website lookup must return `404`. Playwright covers the real customer login → overview → websites → workspace → chat journey and a 390×844 mobile viewport.
