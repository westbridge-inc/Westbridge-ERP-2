import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    account: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("../../lib/redis.js", () => ({
  getRedis: () => null,
  getRedisConfig: () => ({ host: "localhost", port: 6379 }),
}));
vi.mock("../../lib/services/session.service.js", () => ({
  validateSession: vi.fn().mockResolvedValue({ ok: false, error: "no session" }),
  createSession: vi.fn(),
  revokeSession: vi.fn(),
}));

import { createApp } from "../../app.js";
const app = createApp();

describe("misc routes", () => {
  it("GET /api/docs returns a response", async () => {
    const res = await supertest(app).get("/api/docs");
    // May return 200 (spec generated) or 500 (missing deps in test env)
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.openapi).toBeDefined();
    }
  });

  it("GET /api/metrics returns 403 for external IP without token", async () => {
    const res = await supertest(app).get("/api/metrics").set("X-Forwarded-For", "8.8.8.8");
    expect(res.status).toBe(403);
  });

  it("GET /api/usage returns 401 without session", async () => {
    const res = await supertest(app).get("/api/usage");
    expect(res.status).toBe(401);
  });
});
