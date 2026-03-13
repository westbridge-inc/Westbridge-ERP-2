import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the app
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  },
}));

vi.mock("../../lib/redis.js", () => ({
  getRedis: vi.fn().mockReturnValue({
    ping: vi.fn().mockResolvedValue("PONG"),
  }),
  getRedisConfig: vi.fn().mockReturnValue({ host: "localhost", port: 6379 }),
}));

vi.mock("../../lib/services/session.service.js", () => ({
  validateSession: vi.fn(),
  createSession: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock("../../lib/services/audit.service.js", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  auditContext: vi.fn().mockReturnValue({ ipAddress: "127.0.0.1", userAgent: "test" }),
  safeLogAudit: vi.fn(),
}));

vi.mock("../../lib/api/rate-limit-tiers.js", () => ({
  checkTieredRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkEmailRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkErpAccountRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  getClientIdentifier: vi.fn().mockReturnValue("test-client"),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("../../lib/csrf.js", () => ({
  validateCsrf: vi.fn().mockReturnValue(true),
  generateCsrfToken: vi.fn().mockReturnValue("test-csrf-token"),
  verifyCsrfToken: vi.fn().mockReturnValue(true),
  CSRF_COOKIE_NAME: "westbridge_csrf",
  CSRF_HEADER_NAME: "x-csrf-token",
  CSRF_MAX_AGE_SECONDS: 3600,
}));

vi.mock("../../lib/security-monitor.js", () => ({
  reportSecurityEvent: vi.fn(),
}));

// Mocks needed because createApp() loads ALL route files and their transitive imports
vi.mock("../../lib/services/auth.service.js", () => ({
  login: vi.fn(),
}));
vi.mock("../../lib/services/password-reset.service.js", () => ({
  requestPasswordReset: vi.fn().mockResolvedValue({ ok: true, data: { sent: true } }),
  applyPasswordReset: vi.fn().mockResolvedValue({ ok: true, data: { success: true } }),
}));
vi.mock("../../lib/password-policy.js", () => ({
  validatePassword: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}));
vi.mock("../../lib/services/erp.service.js", () => ({
  list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  getDoc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  createDoc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  updateDoc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  deleteDoc: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));
vi.mock("../../lib/services/billing.service.js", () => ({
  createAccount: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  verifyPaymentCallback: vi.fn(),
  isPaymentSuccess: vi.fn(),
  markAccountPaid: vi.fn(),
}));
vi.mock("../../lib/services/invite.service.js", () => ({
  createInvite: vi.fn(),
  acceptInvite: vi.fn(),
}));
vi.mock("../../lib/feature-flags.js", () => ({
  getAllFlags: vi.fn().mockResolvedValue([]),
  setFlag: vi.fn(),
  evaluateFlag: vi.fn(),
}));
vi.mock("../../lib/jobs/queue.js", () => {
  const makeQueue = () => ({
    getWaitingCount: vi.fn().mockResolvedValue(0),
    getActiveCount: vi.fn().mockResolvedValue(0),
    getCompletedCount: vi.fn().mockResolvedValue(0),
    getFailedCount: vi.fn().mockResolvedValue(0),
    getFailed: vi.fn().mockResolvedValue([]),
    getWaiting: vi.fn().mockResolvedValue([]),
    getJob: vi.fn().mockResolvedValue(null),
    add: vi.fn().mockResolvedValue({}),
  });
  return {
    emailQueue: makeQueue(),
    erpSyncQueue: makeQueue(),
    reportsQueue: makeQueue(),
    cleanupQueue: makeQueue(),
    webhooksQueue: makeQueue(),
    enqueueEmail: vi.fn(),
    scheduleCleanupJobs: vi.fn(),
  };
});
vi.mock("../../lib/api/cache-headers.js", () => ({
  cacheControl: { private: vi.fn().mockReturnValue("private, no-cache") },
}));
vi.mock("../../lib/metering.js", () => ({
  meter: {
    increment: vi.fn().mockResolvedValue(undefined),
    get: vi
      .fn()
      .mockResolvedValue({
        api_calls: 0,
        erp_docs_created: 0,
        ai_tokens_input: 0,
        ai_tokens_output: 0,
        active_users_count: 0,
        period: "2026-03",
      }),
    recordActiveUser: vi.fn().mockResolvedValue(undefined),
  },
  estimateAiCost: vi.fn().mockReturnValue(0),
}));
vi.mock("../../lib/analytics/posthog.server.js", () => ({
  identify: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";

const app = createApp();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Health Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /api/health/live ──────────────────────────────────────────────────
  describe("GET /api/health/live", () => {
    it("returns 200 with alive: true", async () => {
      const res = await request(app).get("/api/health/live");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("alive", true);
      expect(res.body).toHaveProperty("uptime_seconds");
      expect(typeof res.body.uptime_seconds).toBe("number");
    });

    it("includes Cache-Control: no-store header", async () => {
      const res = await request(app).get("/api/health/live");

      expect(res.headers["cache-control"]).toBe("no-store");
    });
  });

  // ── GET /api/health/ready ─────────────────────────────────────────────────
  describe("GET /api/health/ready", () => {
    it("returns 200 with ready: true when DB and Redis are healthy", async () => {
      const res = await request(app).get("/api/health/ready");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("ready", true);
      expect(res.body.checks).toEqual({
        database: "ok",
        redis: "ok",
      });
    });

    it("returns 503 when database is unavailable", async () => {
      const { prisma } = await import("../../lib/data/prisma.js");
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB connection failed"));

      const res = await request(app).get("/api/health/ready");

      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty("ready", false);
      expect(res.body.checks.database).toBe("error");
    });

    it("returns 503 when Redis is unavailable", async () => {
      const { getRedis } = await import("../../lib/redis.js");
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        ping: vi.fn().mockRejectedValueOnce(new Error("Redis down")),
      });

      const res = await request(app).get("/api/health/ready");

      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty("ready", false);
      expect(res.body.checks.redis).toBe("error");
    });

    it("returns 503 when Redis is not configured (null)", async () => {
      const { getRedis } = await import("../../lib/redis.js");
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

      const res = await request(app).get("/api/health/ready");

      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty("ready", false);
    });
  });

  // ── GET /api/health ───────────────────────────────────────────────────────
  describe("GET /api/health", () => {
    it("returns 200 with comprehensive health data when all services are healthy", async () => {
      const res = await request(app).get("/api/health");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body.data).toHaveProperty("status");
      expect(res.body.data).toHaveProperty("version");
      expect(res.body.data).toHaveProperty("uptime_seconds");
      expect(res.body.data).toHaveProperty("checks");
      expect(res.body.data).toHaveProperty("timestamp");
      expect(res.body.data.checks).toHaveProperty("database");
      expect(res.body.data.checks).toHaveProperty("redis");
      expect(res.body.data.checks).toHaveProperty("memory");
      expect(res.body.data.checks).toHaveProperty("disk");
    });

    it("includes X-Response-Time and Cache-Control headers", async () => {
      const res = await request(app).get("/api/health");

      expect(res.headers["x-response-time"]).toBeDefined();
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("returns 503 when critical services are unhealthy", async () => {
      const { prisma } = await import("../../lib/data/prisma.js");
      const { getRedis } = await import("../../lib/redis.js");

      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB down"));
      (getRedis as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

      const res = await request(app).get("/api/health");

      expect(res.status).toBe(503);
      expect(res.body.data.status).toBe("unhealthy");
    });
  });
});
