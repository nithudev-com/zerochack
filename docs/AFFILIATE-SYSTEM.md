# Affiliate system

Affiliate codes are cryptographically generated and globally unique. Referral capture creates a random opaque browser token in an HttpOnly, SameSite cookie; only its HMAC-SHA-256 digest is stored. A customer explicitly claims the token after authentication. Tenant and user comparisons reject self-referrals, and a unique customer-tenant constraint prevents duplicate attribution.

Owner configurations are immutable versions containing the attribution window/model, eligible package versions, enforced minimum-payment and new-customer eligibility rules, one-time or recurring behavior, percentage or fixed calculation, recurring duration, payout threshold, and approval requirement. The captured configuration remains attached to attribution, conversions, and commission snapshots.

Only provider-confirmed successful payment transactions enter `createCommissionForPayment`. Transaction and attribution-period uniqueness constraints prevent duplicate conversions and recurring periods. Refunds reverse unpaid commissions without deleting ledger history. Paid commissions require a separate recovery workflow rather than silent negative mutation.

Payout creation uses serializable transactions, a client idempotency key, the configured threshold, and atomic commission assignment. A payout may move `PENDING → APPROVED → PROCESSING → PAID|FAILED`, or be cancelled before processing. `PAID` requires an external provider reference. Every review and transition is audited.
