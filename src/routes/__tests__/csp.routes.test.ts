import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createApp } from "../../app.js";
const app = createApp();

describe("CSP routes", () => {
  it("POST /api/csp-report accepts valid CSP report", async () => {
    const res = await supertest(app)
      .post("/api/csp-report")
      .set("Content-Type", "application/json")
      .send({
        "csp-report": {
          "document-uri": "https://example.com",
          "violated-directive": "script-src",
          "blocked-uri": "https://evil.com",
        },
      });
    expect(res.status).toBe(204);
  });

  it("POST /api/csp-report handles empty body", async () => {
    const res = await supertest(app).post("/api/csp-report").set("Content-Type", "application/json").send({});
    expect(res.status).toBe(204);
  });

  it("POST /api/csp-report handles flat report body", async () => {
    const res = await supertest(app).post("/api/csp-report").set("Content-Type", "application/json").send({
      "document-uri": "https://example.com",
      "violated-directive": "img-src",
    });
    expect(res.status).toBe(204);
  });
});
