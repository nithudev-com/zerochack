# Email automation

Domain events are stored once, preferences are applied per recipient, an immutable enabled template version is selected, and a durable email delivery is queued. Templates support scalar substitutions only and reject executable syntax.

Deliveries use bounded exponential retry, persisted attempts, error codes, deterministic message identifiers, and stale-worker lease recovery. A provider acknowledgement lost after SMTP acceptance can still create an ambiguous delivery; downstream SMTP deduplication and delivery webhooks are recommended.

Owner template creation, preview, enablement, and test-send require Owner role, permission, and recent MFA. Authentication verification/reset tokens use the dedicated authentication email path so raw tokens never enter generic event payloads.
