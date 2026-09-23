# Payments security

Payment adapters own provider-specific checkout, verification, subscription, invoice, refund, cancellation, webhook, and health behavior. Credentials are AES-256-GCM encrypted and never returned by APIs.

Webhooks require exact raw bytes, adapter signature verification, a five-minute freshness window, and a unique provider event ID. Reuse of an event ID with different signed content is rejected. Checkout, payment, webhook, and refund records have durable idempotency keys.

Refund capacity is reserved in a serializable transaction. Pending and successful refunds count against refundable balance, preventing concurrent over-refunds. Provider errors mark the reservation failed rather than reporting success.

No production payment adapter is installed by default. Checkout and payment operations return configuration errors until an authorized adapter is supplied. Production requires provider-side reconciliation, webhook-redelivery monitoring, and settlement comparison.
