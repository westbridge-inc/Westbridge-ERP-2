/**
 * Service Level Objectives (SLOs) -- defines reliability targets.
 * These are internal engineering targets, not customer-facing SLAs.
 * Error budgets are calculated as: 1 - SLO target.
 *
 * This module re-exports existing HTTP metrics from metrics.ts and adds
 * SLO-specific counters/gauges. All new metrics use the custom registry
 * and the `westbridge_` prefix to stay consistent with the rest of the
 * observability stack.
 */
import { Counter, Gauge } from "prom-client";
import { registry, httpRequestsTotal, httpRequestDuration } from "./metrics.js";

// ── SLO Definitions ─────────────────────────────────────────────────────────

export const SLO = {
  /** 99.9% of requests return a non-5xx response within the window */
  availability: {
    target: 0.999,
    window: "30d",
    errorBudget: 1 - 0.999, // 0.1% ~ 43 min/month downtime allowed
  },
  /** 99% of API requests complete in under 500ms (p99 latency) */
  latency: {
    target: 0.99,
    thresholdMs: 500,
    window: "30d",
    errorBudget: 1 - 0.99, // 1% of requests can be slow
  },
  /** 99.5% of ERP data sync operations succeed */
  erpSync: {
    target: 0.995,
    window: "7d",
    errorBudget: 1 - 0.995,
  },
} as const;

// ── Prometheus Metrics for SLO Tracking ──────────────────────────────────────
//
// httpRequestsTotal and httpRequestDuration already exist in metrics.ts and
// are re-exported here for convenience. Only SLO-specific metrics are new.

export { httpRequestsTotal, httpRequestDuration };

/** Requests that completed within the latency SLO threshold */
export const httpRequestsWithinSlo = new Counter({
  name: "westbridge_http_requests_within_slo_total",
  help: "HTTP requests completed within SLO latency threshold",
  labelNames: ["method", "route"] as const,
  registers: [registry],
});

/** Error budget remaining (1.0 = full budget, 0.0 = exhausted) */
export const errorBudgetRemaining = new Gauge({
  name: "westbridge_slo_error_budget_remaining_ratio",
  help: "Remaining error budget as a ratio (1.0 = full, 0.0 = exhausted)",
  labelNames: ["slo"] as const,
  registers: [registry],
});

/** ERP sync operations */
export const erpSyncTotal = new Counter({
  name: "westbridge_erp_sync_operations_total",
  help: "Total ERPNext sync operations",
  labelNames: ["outcome"] as const, // "success" | "failure"
  registers: [registry],
});

// ── SLO Tracking Helpers ────────────────────────────────────────────────────

/**
 * Classify HTTP status code into a status class for SLO tracking.
 */
export function statusClass(code: number): string {
  if (code < 200) return "1xx";
  if (code < 300) return "2xx";
  if (code < 400) return "3xx";
  if (code < 500) return "4xx";
  return "5xx";
}

/**
 * Normalize Express route path for metric labels.
 * Collapses dynamic segments: /api/erp/doc/INV-001 -> /api/erp/doc/:name
 */
export function normalizeRoute(path: string): string {
  if (!path) return "unknown";
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:uuid")
    .replace(/\/\d+/g, "/:id")
    .replace(/\/[A-Z]+-\d+/g, "/:name");
}
