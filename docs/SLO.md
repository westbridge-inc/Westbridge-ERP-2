# Service Level Objectives (SLOs)

Last updated: 2026-04-05

## Overview

SLOs define our internal reliability targets. They are **not** customer-facing
SLAs but engineering goals that guide alerting, incident response, and
capacity planning.

## Definitions

| SLO               | Target      | Window  | Error Budget   | Meaning                               |
| ----------------- | ----------- | ------- | -------------- | ------------------------------------- |
| **Availability**  | 99.9%       | 30 days | 43 min/month   | Less than 0.1% of requests return 5xx |
| **Latency (p99)** | 99% < 500ms | 30 days | 1% of requests | 99% of requests complete under 500ms  |
| **ERP Sync**      | 99.5%       | 7 days  | 0.5% of syncs  | ERPNext API calls succeed             |

## Error Budget Policy

| Budget Remaining | Action                                                                        |
| ---------------- | ----------------------------------------------------------------------------- |
| > 50%            | Normal development velocity. Ship features freely.                            |
| 25-50%           | Caution. Prioritize reliability work alongside features.                      |
| 10-25%           | Slow down. No risky deployments. Fix reliability issues first.                |
| < 10%            | **Freeze.** All engineering effort goes to reliability until budget recovers. |
| Exhausted (0%)   | **Hard freeze.** Only reliability fixes and rollbacks. Post-mortem required.  |

## Monitoring

SLO metrics are exported via Prometheus at `GET /api/metrics`:

- `westbridge_http_requests_total{method, route, status}` -- availability numerator/denominator
- `westbridge_http_request_duration_seconds{method, route, status}` -- latency histogram
- `westbridge_http_requests_within_slo_total{method, route}` -- latency SLO numerator
- `westbridge_slo_error_budget_remaining_ratio{slo}` -- current error budget gauge
- `westbridge_erp_sync_operations_total{outcome}` -- ERP sync success/failure

### Alerting Thresholds

| Alert                | Condition                        | Severity |
| -------------------- | -------------------------------- | -------- |
| ErrorBudgetBurn      | Budget < 25% and burn rate > 2x  | Warning  |
| ErrorBudgetCritical  | Budget < 10%                     | Critical |
| LatencySpiked        | p99 > 1000ms for 5 minutes       | Warning  |
| AvailabilityDegraded | 5xx rate > 1% for 5 minutes      | Critical |
| ERPSyncDegraded      | Failure rate > 5% for 10 minutes | Warning  |

## Prometheus Alert Rules

To be loaded into Alertmanager / Grafana Cloud:

```yaml
groups:
  - name: slo_alerts
    rules:
      - alert: HighErrorRate
        expr: |
          (
            sum(rate(westbridge_http_requests_total{status=~"5.."}[5m]))
            /
            sum(rate(westbridge_http_requests_total[5m]))
          ) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "5xx error rate exceeds 1% for 5 minutes"

      - alert: HighLatency
        expr: |
          histogram_quantile(0.99, sum(rate(westbridge_http_request_duration_seconds_bucket[5m])) by (le))
          > 1.0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "p99 latency exceeds 1000ms for 5 minutes"

      - alert: ErrorBudgetBurn
        expr: westbridge_slo_error_budget_remaining_ratio{slo="availability"} < 0.25
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Availability error budget below 25%"
```
