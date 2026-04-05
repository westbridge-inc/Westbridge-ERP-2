import { describe, it, expect } from "vitest";
import { SLO, statusClass, normalizeRoute } from "../slo.js";

describe("SLO definitions", () => {
  it("availability target is 99.9%", () => {
    expect(SLO.availability.target).toBe(0.999);
  });

  it("latency target is 99% under 500ms", () => {
    expect(SLO.latency.target).toBe(0.99);
    expect(SLO.latency.thresholdMs).toBe(500);
  });

  it("error budgets are correctly calculated", () => {
    expect(SLO.availability.errorBudget).toBeCloseTo(0.001);
    expect(SLO.latency.errorBudget).toBeCloseTo(0.01);
    expect(SLO.erpSync.errorBudget).toBeCloseTo(0.005);
  });
});

describe("statusClass", () => {
  it("classifies 200 as 2xx", () => expect(statusClass(200)).toBe("2xx"));
  it("classifies 201 as 2xx", () => expect(statusClass(201)).toBe("2xx"));
  it("classifies 301 as 3xx", () => expect(statusClass(301)).toBe("3xx"));
  it("classifies 400 as 4xx", () => expect(statusClass(400)).toBe("4xx"));
  it("classifies 404 as 4xx", () => expect(statusClass(404)).toBe("4xx"));
  it("classifies 500 as 5xx", () => expect(statusClass(500)).toBe("5xx"));
  it("classifies 503 as 5xx", () => expect(statusClass(503)).toBe("5xx"));
});

describe("normalizeRoute", () => {
  it("replaces UUIDs", () => {
    expect(normalizeRoute("/api/users/550e8400-e29b-41d4-a716-446655440000")).toBe("/api/users/:uuid");
  });
  it("replaces numeric IDs", () => {
    expect(normalizeRoute("/api/invoices/123")).toBe("/api/invoices/:id");
  });
  it("replaces document names like INV-001", () => {
    expect(normalizeRoute("/api/erp/doc/INV-001")).toBe("/api/erp/doc/:name");
  });
  it("returns unknown for empty path", () => {
    expect(normalizeRoute("")).toBe("unknown");
  });
  it("preserves static paths", () => {
    expect(normalizeRoute("/api/health")).toBe("/api/health");
  });
});
