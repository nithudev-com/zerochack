# Commercial platform

## Commercial truth

Prices and entitlements are stored in `package_versions`; no production price is defined in application code. A package is a stable identity and every publication creates a new immutable version. Existing subscriptions, invoices, and quotes retain both the version foreign key and an exact JSON terms snapshot. Package versions have no update or delete endpoint.

Amounts use integer minor currency units. Currency totals are never combined: the owner dashboard reports gross, refunds, and net grouped by ISO currency. The allowed subscription states are `TRIALING`, `ACTIVE`, `PAST_DUE`, `PAUSED`, `CANCELLED`, and `EXPIRED`.

## Provider boundary

`@zerochack/payments` defines `PaymentProvider` for checkout, verification, provider subscriptions/trials, invoices, refunds, cancellations, webhooks, and health. Adapters are injected into the API process; this repository intentionally includes no pretend production provider. Provider records can be staged disabled, but enabling one requires an installed adapter and encrypted credentials. `PAYMENT_CREDENTIAL_ENCRYPTION_KEY` is a distinct AES-256-GCM key and is mandatory in production.

Checkout creates a `PENDING` transaction. Only a positive provider verification or a verified webhook can create an `ACTIVE` subscription and `PAID` invoice. A checkout URL never indicates payment success. Returned checkout URLs must be HTTPS (localhost HTTP is accepted only outside production).

## Webhooks and idempotency

Provider webhook adapters verify exact raw bytes submitted as `application/webhook+json`. Events outside the five-minute replay tolerance are rejected. `(provider_config_id, provider_event_id)` is unique, so duplicate delivery returns success without processing twice. The database stores a SHA-256 payload hash, normalized event metadata, and processing outcome—not raw provider payloads or credentials.

Checkout keys are unique per tenant, provider event IDs are unique per provider, refund keys are globally unique UUIDs, and trial keys are unique. Financial state changes and provider operations are audited without secrets.

## Quotes

Owner-created quotes support custom line items and optional package versions. Totals are calculated server-side. Valid transitions are enforced: `DRAFT → SENT → VIEWED → ACCEPTED`; sent/viewed quotes can be rejected or cancelled and overdue sent/viewed quotes become expired. Quote acceptance is not payment success.

## API and UI

- Customer: packages, billing summary, checkout, verification, trial, cancellation, and quote view/accept.
- Owner with recent MFA and `commercial.manage`: packages, providers, health, refunds, quotes, and dashboard.
- Provider: `POST /v1/payments/webhooks/:providerId` with exact signed bytes.

Customer screens are `/customer/subscription` and `/customer/billing`; owner operations are `/owner/commercial`.
