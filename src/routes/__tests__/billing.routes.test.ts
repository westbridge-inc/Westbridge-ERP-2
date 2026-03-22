import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    account: {
      findUnique: vi.fn().mockResolvedValue({
        plan: "starter",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
    },
    user: { findUnique: vi.fn() },
    billingInvoice: { findMany: vi.fn().mockResolvedValue([]) },
    subscription: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("../../lib/redis.js", () => ({
  getRedis: vi.fn().mockReturnValue(null),
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
vi.mock("../../lib/services/subscription.service.js", () => ({
  changePlan: vi.fn(),
  cancelSubscription: vi.fn(),
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

// ---------------------------------------------------------------------------
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateSession } from "../../lib/services/session.service.js";
import { validateCsrf } from "../../lib/csrf.js";
import { changePlan, cancelSubscription } from "../../lib/services/subscription.service.js";

const app = createApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "westbridge_sid=test-session-token";
const CSRF_COOKIE = "westbridge_csrf=test-csrf-token";

function mockSession(role: string) {
  (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    data: {
      userId: "usr_1",
      accountId: "acc_1",
      role,
      erpnextSid: "erp-sid-123",
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Billing Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/billing/history", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/billing/history");

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 403 for viewer role (no billing:read permission)", async () => {
      mockSession("viewer");

      const res = await request(app).get("/api/billing/history").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("returns 403 for member role (no billing:read permission)", async () => {
      mockSession("member");

      const res = await request(app).get("/api/billing/history").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
    });

    it("returns 200 with billing data for manager role (has billing:read)", async () => {
      mockSession("manager");

      const res = await request(app).get("/api/billing/history").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("items");
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data).toHaveProperty("plan");
      expect(res.body.data).toHaveProperty("status");
    });

    it("returns 200 with billing data for owner role", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/billing/history").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("items");
      expect(res.body.data).toHaveProperty("plan", "starter");
      expect(res.body.data).toHaveProperty("status", "active");
      expect(res.body.data).toHaveProperty("accountCreatedAt");
    });

    it("returns empty items array (no invoice rows stored yet)", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/billing/history").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(0);
    });

    it("includes X-Response-Time header", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/billing/history").set("Cookie", SESSION_COOKIE);

      expect(res.headers["x-response-time"]).toBeDefined();
    });
  });

  // ── POST /api/billing/change-plan ─────────────────────────────────────────
  describe("POST /api/billing/change-plan", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app)
        .post("/api/billing/change-plan")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ planId: "Business" });

      expect(res.status).toBe(401);
    });

    it("returns 403 when CSRF is invalid", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
      mockSession("owner");

      const res = await request(app)
        .post("/api/billing/change-plan")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "bad-token")
        .send({ planId: "Business" });

      expect(res.status).toBe(403);
    });

    it("returns 403 for member role (no billing:manage permission)", async () => {
      mockSession("member");

      const res = await request(app)
        .post("/api/billing/change-plan")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ planId: "Business" });

      expect(res.status).toBe(403);
    });

    it("returns 400 for invalid planId", async () => {
      mockSession("owner");

      const res = await request(app)
        .post("/api/billing/change-plan")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ planId: "InvalidPlan" });

      expect(res.status).toBe(400);
    });

    it("returns 400 when missing planId", async () => {
      mockSession("owner");

      const res = await request(app)
        .post("/api/billing/change-plan")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 200 on valid plan change", async () => {
      mockSession("owner");
      (changePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: { planId: "Business", status: "active" },
      });

      const res = await request(app)
        .post("/api/billing/change-plan")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ planId: "Business" });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("planId", "Business");
    });

    it("returns 400 when changePlan service returns error", async () => {
      mockSession("owner");
      (changePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "Already on this plan",
      });

      const res = await request(app)
        .post("/api/billing/change-plan")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ planId: "Starter" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BILLING_ERROR");
    });
  });

  // ── POST /api/billing/cancel ──────────────────────────────────────────────
  describe("POST /api/billing/cancel", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app)
        .post("/api/billing/cancel")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(401);
    });

    it("returns 403 when CSRF is invalid", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
      mockSession("owner");

      const res = await request(app)
        .post("/api/billing/cancel")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "bad-token");

      expect(res.status).toBe(403);
    });

    it("returns 403 for member role (no billing:manage permission)", async () => {
      mockSession("member");

      const res = await request(app)
        .post("/api/billing/cancel")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(403);
    });

    it("returns 200 on successful cancellation", async () => {
      mockSession("owner");
      (cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: { status: "canceled" },
      });

      const res = await request(app)
        .post("/api/billing/cancel")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("status", "canceled");
    });

    it("returns 500 when cancelSubscription service fails", async () => {
      mockSession("owner");
      (cancelSubscription as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "No active subscription",
      });

      const res = await request(app)
        .post("/api/billing/cancel")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("BILLING_ERROR");
    });
  });
});
