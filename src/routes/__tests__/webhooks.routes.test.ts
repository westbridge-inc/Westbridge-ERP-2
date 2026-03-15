import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
    webhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
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

describe("webhooks routes", () => {
  it("GET /api/webhooks requires auth", async () => {
    const res = await supertest(app).get("/api/webhooks");
    expect([401, 404]).toContain(res.status);
  });

  it("POST /api/webhooks requires auth", async () => {
    const res = await supertest(app)
      .post("/api/webhooks")
      .send({ url: "https://example.com/hook", events: ["erp.doc_updated"] });
    expect([401, 403, 404]).toContain(res.status);
  });
});
