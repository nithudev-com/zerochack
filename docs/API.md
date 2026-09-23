# API operations

The Fastify API is versioned under `/v1`. OpenAPI JSON and interactive development documentation are exposed under `/docs`; production ingress should restrict the interactive UI if it is not needed.

Authentication uses the `__Host-zerochack_session` cookie in production. Tenant identity, user identity, roles, and permissions are loaded from the server-side session for every request. Caller-supplied tenant headers, query parameters, and request bodies cannot replace that context.

Errors use `{ "error": { "code", "message", "requestId" } }`. Production responses suppress unexpected internal messages. Request bodies are limited to 1 MiB, validation failures return 400, and API responses use `Cache-Control: no-store`.

Health endpoints:

- `GET /v1/health/live` tests process liveness.
- `GET /v1/health/ready` checks PostgreSQL and Redis and returns 503 on failure.
- `GET /v1/health/metrics` returns Prometheus counters only with `Authorization: Bearer $METRICS_TOKEN`.

The versioned generated artifact is [`openapi.json`](openapi.json), produced from registered route schemas with `npm run openapi:generate`. Runtime interactive documentation remains available at `/docs` and JSON at `/docs/json`; production ingress should restrict the interactive UI if it is not needed.
