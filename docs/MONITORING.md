# Monitoring and observability

The API emits structured JSON logs with service, timestamp, level, request ID, user ID and tenant ID when available, event, duration, status and error code. Known secret fields are redacted. Worker logs include queue and job identifiers.

Prometheus-format API request counters and cumulative duration are available from token-protected `/v1/health/metrics`. Labels use route templates, methods, and status classes to avoid tenant or resource cardinality. Owner system health checks PostgreSQL, Redis, worker heartbeat, queue counts, schedulers, SMTP, configured providers, storage integration, and the latest actual scanner execution.

Production still requires a metrics scraper/dashboard, centralized logs, alert rules, a distributed tracing exporter, an exception-monitoring backend, and on-call routing. A worker heartbeat alone is not a complete SLO system.
