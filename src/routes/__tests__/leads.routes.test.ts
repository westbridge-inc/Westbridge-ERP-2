import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/data/prisma.js", () => ({
  prisma: { auditLog: { create: vi.fn() } },
}));
vi.mock("../../lib/redis.js", () => ({
  getRedis: () => ({
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
vi.mock("../../lib/email/index.js", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, data: "sent" }),
}));

import { createApp } from "../../app.js";
const app = createApp();

describe("leads routes", () => {
  it("POST /api/leads/demo validates input", async () => {
    const res = await supertest(app).post("/api/leads/demo").send({});
    expect(res.status).toBe(400);
  });

  it("POST /api/leads/demo accepts valid lead", async () => {
    const res = await supertest(app).post("/api/leads/demo").send({
      name: "John Doe",
      email: "john@example.com",
      company: "Acme Inc",
      country: "GY",
    });
    expect([200, 429]).toContain(res.status);
  });

  it("POST /api/leads/newsletter validates email", async () => {
    const res = await supertest(app).post("/api/leads/newsletter").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("POST /api/leads/newsletter accepts valid email", async () => {
    const res = await supertest(app).post("/api/leads/newsletter").send({ email: "valid@example.com" });
    expect([200, 429]).toContain(res.status);
  });
});
