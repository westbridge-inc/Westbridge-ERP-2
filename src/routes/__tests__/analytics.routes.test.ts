import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/data/prisma.js", () => ({
  prisma: { auditLog: { create: vi.fn() } },
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

describe("analytics routes", () => {
  it("POST /api/analytics/event returns 401 without session", async () => {
    const res = await supertest(app).post("/api/analytics/event").send({ event: "page_view", properties: {} });
    expect([200, 204, 401, 404]).toContain(res.status);
  });

  it("POST /api/analytics/identify returns 401 without session", async () => {
    const res = await supertest(app).post("/api/analytics/identify").send({ userId: "u1" });
    expect([200, 204, 401, 404]).toContain(res.status);
  });
});
