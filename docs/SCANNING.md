# Website connection and scanning

## Trust boundary

Entering a URL never authorizes a scan. A website must complete one of three one-hour ownership challenges—DNS TXT, an HTTP well-known file, or a connector-token well-known endpoint—and then pass a safe connection test. Tokens are generated cryptographically, stored only as keyed hashes, expire, and are superseded when a new challenge is created. A URL change clears connection authorization.

The API derives tenant scope from the authenticated session. Scan jobs contain tenant, website, and scan IDs, and the worker re-queries all three together before network work. Composite database foreign keys prevent findings and evidence from crossing tenant, website, or scan boundaries even if application code is defective.

## Outbound request policy

`@zerochack/scanner` accepts only HTTP port 80 and HTTPS port 443. It rejects credentials in URLs, localhost and internal names, loopback, private, carrier-grade NAT, link-local, documentation, benchmarking, multicast, reserved, and metadata-service address ranges.

Every DNS answer must be public. Requests are pinned to a validated address through Undici's lookup hook while TLS retains the original hostname. Redirects are manual, bounded, re-resolved, revalidated, and restricted to the verified hostname. Response size, redirect count, and timeouts are configurable. Response bodies are bounded and never stored as evidence.

The scanner runs only in the worker container. Production must also apply the provided egress NetworkPolicy template or an equivalent firewall: PostgreSQL, Redis, DNS, and public TCP 80/443 only, with private and metadata ranges denied.

## Implemented engines

- `http-headers` 1.0.0: HSTS, Content Security Policy, MIME sniffing protection, and Referrer Policy.
- `http-information-exposure` 1.0.0: presence-only checks for `Server` and `X-Powered-By`; values are deliberately not retained.

The `SecurityEngine` interface is the extension boundary for TLS, configuration, dependency/CVE, integrity, malware, application-security, and monitoring adapters. Those adapters are not claimed as implemented or displayed as executed.

## Orchestration and evidence

The API creates one active scan per tenant website and queues three exponential-backoff attempts. The worker reauthorizes the persisted target, records progress per engine, and transactionally persists normalized findings and evidence before completing the scan and updating posture. Failed intermediate attempts return to queued; the last attempt records a safe failure code. Completion, retry, and failure are audited.

Evidence contains engine/version, observation time, scan and finding references, a bounded summary, redacted structured metadata, and a SHA-256 integrity hash. It never stores response bodies, authorization material, cookies, tokens, or present header values.
