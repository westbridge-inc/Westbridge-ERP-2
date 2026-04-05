/**
 * SLO tracking middleware -- records latency and availability metrics
 * for every HTTP request. Feeds Prometheus counters/histograms used
 * to calculate error budgets.
 *
 * Mount early in the middleware chain (right after response-time) so
 * the timer captures the full request lifecycle.
 */
import type { Request, Response, NextFunction } from "express";
import { httpRequestsTotal, httpRequestDuration, httpRequestsWithinSlo, normalizeRoute, SLO } from "../lib/slo.js";

export function sloTracking(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  // Prevent MaxListenersExceededWarning — multiple middleware add finish listeners
  const current = res.getMaxListeners();
  if (current <= 15) res.setMaxListeners(current + 1);

  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
    const route = normalizeRoute(req.route?.path ?? req.path);
    const method = req.method;
    const status = String(res.statusCode);

    // Availability SLO: count by status (existing metric labels use "status", not "status_class")
    httpRequestsTotal.inc({ method, route, status });

    // Latency SLO: record duration
    httpRequestDuration.observe({ method, route, status }, durationSec);

    // Latency SLO: count requests within threshold
    if (durationSec * 1000 <= SLO.latency.thresholdMs) {
      httpRequestsWithinSlo.inc({ method, route });
    }
  });

  next();
}
