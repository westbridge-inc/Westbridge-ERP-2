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
vi.mock("../../lib/realtime.js", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  publish: vi.fn(),
  GLOBAL_CHANNEL: "realtime:*",
}));

import { createApp } from "../../app.js";
const app = createApp();

describe("events routes", () => {
  it("GET /api/events/stream returns 401 without session", async () => {
    const res = await supertest(app).get("/api/events/stream");
    expect(res.status).toBe(401);
  });
});
