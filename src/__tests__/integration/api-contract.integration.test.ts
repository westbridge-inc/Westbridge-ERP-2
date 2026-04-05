/**
 * API Contract Tests (B2)
 *
 * Validates the response shape of every major API endpoint using Zod schemas.
 * These tests define the contract between frontend and backend. If a backend
 * change breaks the response shape, these tests catch it before the frontend breaks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the app
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    account: {
      findUnique: vi.fn().mockResolvedValue({
        id: "acc-1",
        email: "test@test.com",
        plan: "starter",
        status: "active",
        companyName: "Test Co",
        erpnextCompany: "Test Co",
        createdAt: new Date("2026-01-01"),
      }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: "user-1",
        accountId: "acc-1",
        email: "test@test.com",
        name: "Test User",
        role: "owner",
        status: "active",
        failedLoginAttempts: 0,
        lockedUntil: null,
      }),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../../lib/redis.js", () => {
  const pipeline = () => {
    const pipe: Record<string, unknown> = {};
    const self = () => pipe;
    pipe.zadd = self;
    pipe.zremrangebyscore = self;
    pipe.zcard = self;
    pipe.del = self;
    pipe.pexpire = self;
    pipe.expire = self;
    pipe.set = self;
    pipe.get = self;
    pipe.exec = () =>
      Promise.resolve([
        [null, 0],
        [null, 0],
      ]);
    return pipe;
  };
  return {
    getRedis: vi.fn().mockReturnValue({
      ping: vi.fn().mockResolvedValue("PONG"),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      publish: vi.fn().mockResolvedValue(0),
      subscribe: vi.fn().mockResolvedValue(undefined),
      pipeline,
    }),
    getRedisConfig: vi.fn().mockReturnValue({ host: "localhost", port: 6379 }),
  };
});

vi.mock("../../lib/services/session.service.js", () => ({
  validateSession: vi.fn().mockResolvedValue({
    ok: true,
    data: { userId: "user-1", accountId: "acc-1", role: "owner", erpnextSid: "sid-123" },
  }),
  createSession: vi.fn().mockResolvedValue({
    ok: true,
    data: { token: "session-token-abc", expiresAt: new Date(Date.now() + 86400000) },
  }),
  revokeSession: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../../lib/services/auth.service.js", () => ({
  login: vi.fn().mockResolvedValue({ ok: true, data: "erp-session-id" }),
  changePassword: vi.fn(),
}));

vi.mock("../../lib/services/password-reset.service.js", () => ({
  requestPasswordReset: vi.fn().mockResolvedValue({ ok: true, data: { sent: true } }),
  applyPasswordReset: vi.fn().mockResolvedValue({ ok: true, data: { success: true } }),
}));

vi.mock("../../lib/password-policy.js", () => ({
  validatePassword: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}));

vi.mock("../../lib/services/erp.service.js", () => ({
  list: vi.fn().mockResolvedValue({
    ok: true,
    data: [{ name: "INV-001", doctype: "Sales Invoice", grand_total: 100 }],
  }),
  getDoc: vi.fn().mockResolvedValue({
    ok: true,
    data: { name: "INV-001", doctype: "Sales Invoice", grand_total: 100 },
  }),
  createDoc: vi.fn().mockResolvedValue({
    ok: true,
    data: { name: "INV-002", doctype: "Sales Invoice" },
  }),
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
    get: vi.fn().mockResolvedValue({
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

vi.mock("../../lib/services/dashboard.service.js", () => ({
  buildDashboardData: vi.fn().mockResolvedValue({
    invoices: { count: 10, revenue: 5000 },
    orders: { count: 5 },
    recentActivity: [],
  }),
}));

// ---------------------------------------------------------------------------
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";

const app = createApp();

// ---------------------------------------------------------------------------
// Zod schemas for API response contracts
// ---------------------------------------------------------------------------

const metaSchema = z.object({
  timestamp: z.string(),
  request_id: z.string().optional(),
});

const apiSuccessSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    data: dataSchema,
    meta: metaSchema.passthrough(),
  });

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string()).optional(),
  }),
  meta: metaSchema.passthrough(),
});

const healthDataSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  version: z.string(),
  uptime_seconds: z.number(),
  checks: z
    .object({
      database: z.object({ status: z.string(), latency_ms: z.number() }),
      redis: z.object({ status: z.string(), latency_ms: z.number() }),
      memory: z.object({ status: z.string(), latency_ms: z.number() }),
      disk: z.object({ status: z.string(), latency_ms: z.number() }),
    })
    .passthrough(),
  timestamp: z.string(),
});

const erpListMetaSchema = metaSchema.extend({
  page: z.number(),
  pageSize: z.number(),
  hasMore: z.boolean(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("API Contract Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Health endpoint ─────────────────────────────────────────────────────
  describe("GET /api/health", () => {
    it("matches the health response contract", async () => {
      const res = await request(app).get("/api/health");

      expect(res.status).toBe(200);
      const result = apiSuccessSchema(healthDataSchema).safeParse(res.body);
      expect(result.success).toBe(true);
    });

    it("includes required headers", async () => {
      const res = await request(app).get("/api/health");

      expect(res.headers["x-response-time"]).toBeDefined();
      expect(res.headers["cache-control"]).toBe("no-store");
    });
  });

  // ── Health liveness ─────────────────────────────────────────────────────
  describe("GET /api/health/live", () => {
    it("matches the liveness contract", async () => {
      const res = await request(app).get("/api/health/live");

      expect(res.status).toBe(200);
      const schema = z.object({
        alive: z.literal(true),
        uptime_seconds: z.number(),
      });
      expect(schema.safeParse(res.body).success).toBe(true);
    });
  });

  // ── Auth validate ───────────────────────────────────────────────────────
  describe("GET /api/auth/validate", () => {
    it("returns 401 with error contract when no session", async () => {
      const res = await request(app).get("/api/auth/validate");

      expect(res.status).toBe(401);
      const result = apiErrorSchema.safeParse(res.body);
      expect(result.success).toBe(true);
    });

    it("returns user data matching contract when session valid", async () => {
      const res = await request(app).get("/api/auth/validate").set("Cookie", "westbridge_sid=valid-session");

      expect(res.status).toBe(200);
      const validateDataSchema = z.object({
        userId: z.string(),
        accountId: z.string(),
        role: z.string(),
        email: z.string(),
        name: z.string(),
      });
      const result = apiSuccessSchema(validateDataSchema).safeParse(res.body);
      expect(result.success).toBe(true);
    });
  });

  // ── Auth login ──────────────────────────────────────────────────────────
  describe("POST /api/auth/login", () => {
    it("returns error contract on validation failure", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", "westbridge_csrf=csrf-tok")
        .set("x-csrf-token", "csrf-tok")
        .send({ email: "not-an-email", password: "" });

      expect(res.status).toBe(400);
      const result = apiErrorSchema.safeParse(res.body);
      expect(result.success).toBe(true);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns success contract on valid login", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", "westbridge_csrf=csrf-tok")
        .set("x-csrf-token", "csrf-tok")
        .send({ email: "test@test.com", password: "password123" });

      expect(res.status).toBe(200);
      const successDataSchema = z.object({
        success: z.literal(true),
      });
      const result = apiSuccessSchema(successDataSchema).safeParse(res.body);
      expect(result.success).toBe(true);
    });
  });

  // ── ERP list ────────────────────────────────────────────────────────────
  describe("GET /api/erp/list", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).get("/api/erp/list?doctype=Sales Invoice");

      expect(res.status).toBe(401);
      const result = z
        .object({
          ok: z.literal(false),
          error: z.object({ code: z.string(), message: z.string() }),
        })
        .safeParse(res.body);
      expect(result.success).toBe(true);
    });

    it("returns list data matching contract when authenticated", async () => {
      const { validateSession } = await import("../../lib/services/session.service.js");
      vi.mocked(validateSession).mockResolvedValueOnce({
        ok: true,
        data: { userId: "user-1", accountId: "acc-1", role: "owner", erpnextSid: "sid-123" },
      });

      const res = await request(app)
        .get("/api/erp/list?doctype=Sales+Invoice")
        .set("Cookie", "westbridge_sid=valid-session");

      expect(res.status).toBe(200);
      const listSchema = z.object({
        data: z.array(z.record(z.unknown())),
        meta: erpListMetaSchema.passthrough(),
      });
      const result = listSchema.safeParse(res.body);
      expect(result.success).toBe(true);
    });
  });

  // ── ERP create doc ──────────────────────────────────────────────────────
  describe("POST /api/erp/doc", () => {
    it("returns created doc matching contract when authenticated", async () => {
      const { validateSession } = await import("../../lib/services/session.service.js");
      vi.mocked(validateSession).mockResolvedValueOnce({
        ok: true,
        data: { userId: "user-1", accountId: "acc-1", role: "owner", erpnextSid: "sid-123" },
      });

      const res = await request(app)
        .post("/api/erp/doc")
        .set("Cookie", "westbridge_sid=valid-session; westbridge_csrf=csrf-tok")
        .set("x-csrf-token", "csrf-tok")
        .send({ doctype: "Sales Invoice", customer: "Cust-001" });

      expect(res.status).toBe(200);
      const docSchema = z.object({
        data: z.record(z.unknown()),
        meta: metaSchema.passthrough(),
      });
      const result = docSchema.safeParse(res.body);
      expect(result.success).toBe(true);
    });
  });

  // ── 404 handler ─────────────────────────────────────────────────────────
  describe("Unknown routes", () => {
    it("returns NOT_FOUND error matching contract", async () => {
      const res = await request(app).get("/api/nonexistent");

      expect(res.status).toBe(404);
      const result = z
        .object({
          ok: z.literal(false),
          error: z.object({
            code: z.literal("NOT_FOUND"),
            message: z.string(),
          }),
        })
        .safeParse(res.body);
      expect(result.success).toBe(true);
    });
  });

  // ── Deprecation headers on unversioned routes (B5) ─────────────────────
  describe("Deprecation headers", () => {
    it("sets Deprecation/Sunset/Link on unversioned /api/ routes", async () => {
      const res = await request(app).get("/api/health/live");

      expect(res.headers["deprecation"]).toBe("true");
      expect(res.headers["sunset"]).toBe("2026-09-01");
      expect(res.headers["link"]).toBe('</api/v1/>; rel="successor-version"');
    });

    it("does NOT set deprecation headers on versioned /api/v1/ routes", async () => {
      const res = await request(app).get("/api/v1/health/live");

      expect(res.headers["deprecation"]).toBeUndefined();
      expect(res.headers["sunset"]).toBeUndefined();
    });
  });

  // ── Response time header (B4) ──────────────────────────────────────────
  describe("Response time header", () => {
    it.skip("includes X-Response-Time on every response", async () => {
      const res = await request(app).get("/api/health/live");

      expect(res.headers["x-response-time"]).toBeDefined();
      expect(res.headers["x-response-time"]).toMatch(/^\d+(\.\d+)?ms$/);
    });
  });
});
