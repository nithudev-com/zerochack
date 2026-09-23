# Monitoring foundation

Services emit structured JSON logs with request/tenant/user correlation where available. The API exposes liveness at `/v1/health/live`, PostgreSQL/Redis readiness at `/v1/health/ready`, and low-cardinality Prometheus counters at `/v1/health/metrics`. Metrics require the exact bearer value in `METRICS_TOKEN`; unauthorized requests receive a generic 404.

Metrics are in-process and per replica. A production platform must select and configure scraping, aggregation, tracing, error monitoring, dashboards, alert routing, retention, and incident management. No dashboard or paging integration is claimed by this repository.
