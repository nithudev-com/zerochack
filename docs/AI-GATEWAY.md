# Central AI Gateway

## Request path

All model traffic follows `web -> /v1 API -> @zerochack/ai-gateway -> registered provider adapter -> provider`. Browser code sends only the prompt, references, and an idempotency UUID. It never receives a provider credential. The implemented adapter uses a server-side Responses endpoint with provider-side response storage disabled.

Provider, credential, model, tenant policy, and usage records are database-backed. Provider credentials are encrypted with AES-256-GCM using `AI_CREDENTIAL_ENCRYPTION_KEY`; list and mutation responses never return ciphertext or plaintext. A production secret manager must inject a unique key. Rotation increments the credential key version, but migrating ciphertext between master keys requires a controlled external procedure.

AI is deny-by-default. An Owner with recent MFA and `ai.providers.manage` must create a provider, encrypted credential, model, and enabled tenant policy. Management endpoints are under `/v1/owner/ai`. Only adapter keys compiled into the backend are accepted; arbitrary provider URLs are not.

## Authorization and isolation

The API derives tenant and roles from the authenticated session. Website, finding, evidence, and ticket queries combine IDs with that tenant and website. Client tenant headers and query values are ignored. Customer, Agency, Specialist, and Owner policies may use security context when RBAC also allows it. Affiliate may use only general AI and cannot reach website security endpoints or receive security context.

Security context is minimized, secret-redacted, serialized as data, and enclosed in `<untrusted_security_context>`. Trusted instructions say website content, scanner output, evidence, and uploads are untrusted and must never be followed as instructions. This reduces prompt-injection risk; it is not a mathematical guarantee. Finding explanations are validated for the five required sections and remain ordinary AI chat messages. Severity, evidence, and status remain authoritative database fields.

## Agent tools

Security chat may receive a small, request-scoped set of server-side function tools. The Responses adapter executes at most four model turns, disables parallel tool calls, validates tool names against the application registry, returns sanitized failures, and sends tool outputs back to the model for a final user-facing answer.

The initial tools are `check_ssh_access`, `run_read_only_security_assessment`, and `request_live_access_specialist`. They operate only on the authenticated tenant and website already bound to the API route. A successful SSH check is followed by the read-only assessment in the same agent turn. Missing or failed access stops assessment and produces corrective guidance; a customer who does not know the access details can explicitly request immediate live-specialist handoff. SSH secrets stay encrypted at rest, are decrypted only inside the server-side SSH operation, and are never included in model input or tool output. The assessment can record verified findings but cannot change server files. Remediation remains unavailable to AI and requires the existing payment, specialist, authorization, backup, and time-limited-session controls.

## Limits, retries, and accounting

Redis enforces tenant, user, provider, and model request limits plus tenant, provider, and model concurrency semaphores. A daily tenant cost ceiling uses persisted successful usage. Estimated cost comes from Owner-configured per-million-token prices; it is an estimate, not billing truth. Usage captures tenant, user, provider, credential reference, model, tokens, latency, status, request ID, errors, and estimated cost without plaintext credentials.

Idempotency is unique per tenant, user, and UUID. Completed requests return the existing result. Retryable network or provider 5xx failures receive one retry with the same credential. HTTP 429 is not retried and never causes credential switching.

## Operations

- Configure current model prices and limits; no pricing is seeded.
- Review `/v1/owner/ai/usage` and provider health state.
- Successful calls mark the selected provider and credential healthy; provider failures mark them degraded.
- Keep provider processing, retention, regional, and incident-response terms under review.
- No provider is preconfigured, and default tests make no live provider call.
