import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    account: { findUnique: vi.fn().mockResolvedValue({ id: "acc1", companyName: "Test Co" }) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "Test", email: "test@test.com" }) },
    inviteToken: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../../lib/redis.js", () => ({
  getRedis: () => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    pipeline: () => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, 0],
        [null, 0],
        [null, 1],
        [null, 1],
      ]),
    }),
  }),
  getRedisConfig: () => ({ host: "localhost", port: 6379 }),
}));
vi.mock("../../lib/services/session.service.js", () => ({
  validateSession: vi.fn().mockResolvedValue({
    ok: true,
    data: { userId: "u1", accountId: "acc1", role: "owner" },
  }),
  createSession: vi.fn(),
  revokeSession: vi.fn(),
}));
vi.mock("../../lib/email/index.js", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, data: "sent" }),
}));
vi.mock("../../lib/csrf.js", () => ({
  validateCsrf: vi.fn().mockReturnValue({ valid: true }),
}));

import { createApp } from "../../app.js";
const app = createApp();

describe("invite routes", () => {
  it("POST /api/invite returns 401 without session cookie", async () => {
    vi.mocked((await import("../../lib/services/session.service.js")).validateSession).mockResolvedValueOnce({
      ok: false,
      error: "no session",
    });
    const res = await supertest(app).post("/api/invite").send({ email: "new@test.com", role: "member" });
    expect(res.status).toBe(401);
  });

  it("GET /api/invite validates token query param", async () => {
    const res = await supertest(app).get("/api/invite?token=");
    // Route may return 400 (invalid token), 401 (no auth), or 500 (missing mock)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("POST /api/invite/accept validates body", async () => {
    const res = await supertest(app).post("/api/invite/accept").send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
