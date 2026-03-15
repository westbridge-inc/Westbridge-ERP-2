import { describe, it, expect } from "vitest";
import {
  registry,
  httpRequestDuration,
  httpRequestsTotal,
  activeSessionsGauge,
  authAttemptsTotal,
  erpApiDuration,
  erpApiErrorsTotal,
  dbQueryDuration,
  webhookProcessingDuration,
  rateLimitHitsTotal,
  cacheHitsTotal,
  cacheMissesTotal,
  recordHttpRequest,
} from "../metrics.js";

describe("metrics", () => {
  it("registry is defined", () => {
    expect(registry).toBeDefined();
  });

  it("all metrics are registered", async () => {
    const metrics = await registry.getMetricsAsJSON();
    const names = metrics.map((m) => m.name);
    expect(names).toContain("westbridge_http_request_duration_seconds");
    expect(names).toContain("westbridge_http_requests_total");
    expect(names).toContain("westbridge_active_sessions_total");
    expect(names).toContain("westbridge_auth_attempts_total");
    expect(names).toContain("westbridge_erp_api_duration_seconds");
  });

  it("httpRequestDuration is a histogram", () => {
    expect(httpRequestDuration).toBeDefined();
  });

  it("httpRequestsTotal is a counter", () => {
    expect(httpRequestsTotal).toBeDefined();
  });

  it("activeSessionsGauge is a gauge", () => {
    expect(activeSessionsGauge).toBeDefined();
  });

  it("authAttemptsTotal is a counter", () => {
    expect(authAttemptsTotal).toBeDefined();
  });

  it("erpApiDuration is a histogram", () => {
    expect(erpApiDuration).toBeDefined();
  });

  it("erpApiErrorsTotal is a counter", () => {
    expect(erpApiErrorsTotal).toBeDefined();
  });

  it("dbQueryDuration is a histogram", () => {
    expect(dbQueryDuration).toBeDefined();
  });

  it("webhookProcessingDuration is a histogram", () => {
    expect(webhookProcessingDuration).toBeDefined();
  });

  it("rateLimitHitsTotal is a counter", () => {
    expect(rateLimitHitsTotal).toBeDefined();
  });

  it("cache metrics are defined", () => {
    expect(cacheHitsTotal).toBeDefined();
    expect(cacheMissesTotal).toBeDefined();
  });

  describe("recordHttpRequest", () => {
    it("records request without throwing", () => {
      expect(() => recordHttpRequest("GET", "/api/health", 200, 50)).not.toThrow();
    });

    it("handles various status codes", () => {
      expect(() => recordHttpRequest("POST", "/api/auth/login", 401, 100)).not.toThrow();
      expect(() => recordHttpRequest("GET", "/api/erp/list", 500, 5000)).not.toThrow();
    });
  });

  it("registry can output prometheus format", async () => {
    const output = await registry.metrics();
    expect(output).toContain("westbridge_");
  });
});
