/**
 * Prometheus metrics registry.
 * Exposed at GET /api/metrics (internal only — protect behind IP allowlist or auth).
 *
 * Import and call the increment/observe helpers from any API route or service.
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

const registry = new Registry();

// Collect default Node.js metrics (heap, event loop, etc.)
collectDefaultMetrics({ register: registry, prefix: "westbridge_" });

// ─── HTTP ────────────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: "westbridge_http_request_duration_seconds",
  help: "HTTP request latency",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "westbridge_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

// ─── Sessions ────────────────────────────────────────────────────────────────

export const activeSessionsGauge = new Gauge({
  name: "westbridge_active_sessions_total",
  help: "Number of active sessions",
  registers: [registry],
});

// ─── Auth ────────────────────────────────────────────────────────────────────

export const authAttemptsTotal = new Counter({
  name: "westbridge_auth_attempts_total",
  help: "Auth attempts by result",
  labelNames: ["result"] as const, // 'success' | 'failure' | 'lockout'
  registers: [registry],
});

// ─── ERP API ─────────────────────────────────────────────────────────────────

export const erpApiDuration = new Histogram({
  name: "westbridge_erp_api_duration_seconds",
  help: "ERP API call latency",
  labelNames: ["endpoint", "method"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const erpApiErrorsTotal = new Counter({
  name: "westbridge_erp_api_errors_total",
  help: "ERP API errors",
  labelNames: ["endpoint", "error_type"] as const,
  registers: [registry],
});

// ─── Database ────────────────────────────────────────────────────────────────

export const dbQueryDuration = new Histogram({
  name: "westbridge_db_query_duration_seconds",
  help: "Database query latency",
  labelNames: ["operation", "model"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

// ─── Webhooks ────────────────────────────────────────────────────────────────

export const webhookProcessingDuration = new Histogram({
  name: "westbridge_webhook_processing_duration_seconds",
  help: "Webhook processing latency",
  labelNames: ["provider", "event_type"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

// ─── Rate limiting ───────────────────────────────────────────────────────────

export const rateLimitHitsTotal = new Counter({
  name: "westbridge_rate_limit_hits_total",
  help: "Rate limit rejections by endpoint",
  labelNames: ["endpoint"] as const,
  registers: [registry],
});

// ─── Cache ───────────────────────────────────────────────────────────────────

export const cacheHitsTotal = new Counter({
  name: "westbridge_cache_hits_total",
  help: "Cache hits",
  labelNames: ["cache"] as const,
  registers: [registry],
});

export const cacheMissesTotal = new Counter({
  name: "westbridge_cache_misses_total",
  help: "Cache misses",
  labelNames: ["cache"] as const,
  registers: [registry],
});

// ─── SLO helpers ─────────────────────────────────────────────────────────────

/** Record an HTTP request after it completes. */
export function recordHttpRequest(method: string, route: string, status: number, durationMs: number) {
  const labels = { method, route, status: String(status) };
  httpRequestDuration.observe(labels, durationMs / 1000);
  httpRequestsTotal.inc(labels);
}

export { registry };
