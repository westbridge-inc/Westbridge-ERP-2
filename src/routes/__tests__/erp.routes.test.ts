import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    account: {
      findUnique: vi.fn().mockResolvedValue({ erpnextCompany: "Test Corp" }),
    },
    user: { findUnique: vi.fn() },
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

vi.mock("../../lib/services/erp.service.js", () => ({
  list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  getDoc: vi.fn().mockResolvedValue({ ok: true, data: { name: "INV-001" } }),
  createDoc: vi.fn().mockResolvedValue({ ok: true, data: { name: "INV-002" } }),
  updateDoc: vi.fn().mockResolvedValue({ ok: true, data: { name: "INV-001" } }),
  deleteDoc: vi.fn().mockResolvedValue({ ok: true, data: { message: "deleted" } }),
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

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
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
vi.mock("../../lib/analytics/posthog.server.js", () => ({
  identify: vi.fn(),
  capture: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateSession } from "../../lib/services/session.service.js";
import { validateCsrf } from "../../lib/csrf.js";

const app = createApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "westbridge_sid=test-session-token";
const CSRF_COOKIE = "westbridge_csrf=test-csrf-token";

function mockAuthenticatedSession(
  overrides: Partial<{ userId: string; accountId: string; role: string; erpnextSid: string | null }> = {},
) {
  (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    data: {
      userId: "usr_1",
      accountId: "acc_1",
      role: "owner",
      erpnextSid: "erp-sid-123",
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ERP Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  // ── GET /api/erp/list ─────────────────────────────────────────────────────
  describe("GET /api/erp/list", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/erp/list?doctype=Sales+Invoice");

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 when doctype is missing", async () => {
      mockAuthenticatedSession();

      const res = await request(app).get("/api/erp/list").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("doctype");
    });

    it("returns 400 for an unsupported doctype", async () => {
      mockAuthenticatedSession();

      const res = await request(app).get("/api/erp/list?doctype=Forbidden+Type").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("unsupported");
    });

    it("returns 200 with data for a valid request", async () => {
      mockAuthenticatedSession();

      const res = await request(app).get("/api/erp/list?doctype=Sales+Invoice").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("returns 401 when ERP session is not available", async () => {
      mockAuthenticatedSession({ erpnextSid: null });

      const res = await request(app).get("/api/erp/list?doctype=Sales+Invoice").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(401);
    });

    it("handles pagination parameters", async () => {
      mockAuthenticatedSession();

      const res = await request(app)
        .get("/api/erp/list?doctype=Sales+Invoice&page=0&limit=10")
        .set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
    });
  });

  // ── GET /api/erp/doc ──────────────────────────────────────────────────────
  describe("GET /api/erp/doc", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/erp/doc?doctype=Sales+Invoice&name=INV-001");

      expect(res.status).toBe(401);
    });

    it("returns 400 when doctype or name is missing", async () => {
      mockAuthenticatedSession();

      const res = await request(app).get("/api/erp/doc?doctype=Sales+Invoice").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("name");
    });

    it("returns 400 when both doctype and name are missing", async () => {
      mockAuthenticatedSession();

      const res = await request(app).get("/api/erp/doc").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(400);
    });

    it("returns 200 with doc data for valid request", async () => {
      mockAuthenticatedSession();

      const res = await request(app)
        .get("/api/erp/doc?doctype=Sales+Invoice&name=INV-001")
        .set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("name", "INV-001");
    });
  });

  // ── POST /api/erp/doc ─────────────────────────────────────────────────────
  describe("POST /api/erp/doc", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).post("/api/erp/doc").send({ doctype: "Sales Invoice" });

      expect(res.status).toBe(401);
    });

    it("returns 403 when CSRF is invalid", async () => {
      mockAuthenticatedSession();
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app)
        .post("/api/erp/doc")
        .set("Cookie", SESSION_COOKIE)
        .send({ doctype: "Sales Invoice" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("returns 200 for a valid create request", async () => {
      mockAuthenticatedSession();

      const res = await request(app)
        .post("/api/erp/doc")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ doctype: "Sales Invoice", customer: "Test Customer" });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("name", "INV-002");
    });

    it("returns 400 for unsupported doctype", async () => {
      mockAuthenticatedSession();

      const res = await request(app)
        .post("/api/erp/doc")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ doctype: "InvalidDoctype", customer: "Test Customer" });

      expect(res.status).toBe(400);
    });
  });

  // ── PUT /api/erp/doc ──────────────────────────────────────────────────────
  describe("PUT /api/erp/doc", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).put("/api/erp/doc").send({ doctype: "Sales Invoice", name: "INV-001" });

      expect(res.status).toBe(401);
    });

    it("returns 403 when CSRF is invalid", async () => {
      mockAuthenticatedSession();
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app)
        .put("/api/erp/doc")
        .set("Cookie", SESSION_COOKIE)
        .send({ doctype: "Sales Invoice", name: "INV-001" });

      expect(res.status).toBe(403);
    });

    it("returns 200 for a valid update request", async () => {
      mockAuthenticatedSession();

      const res = await request(app)
        .put("/api/erp/doc")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ doctype: "Sales Invoice", name: "INV-001", status: "Paid" });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("name", "INV-001");
    });

    it("returns 400 when name is missing for update", async () => {
      mockAuthenticatedSession();

      const res = await request(app)
        .put("/api/erp/doc")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ doctype: "Sales Invoice" });

      expect(res.status).toBe(400);
    });
  });

  // ── DELETE /api/erp/doc ───────────────────────────────────────────────────
  describe("DELETE /api/erp/doc", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).delete("/api/erp/doc?doctype=Sales+Invoice&name=INV-001");

      expect(res.status).toBe(401);
    });

    it("returns 403 when CSRF is invalid", async () => {
      mockAuthenticatedSession();
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app)
        .delete("/api/erp/doc?doctype=Sales+Invoice&name=INV-001")
        .set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
    });

    it("returns 200 for a valid delete request", async () => {
      mockAuthenticatedSession();

      const res = await request(app)
        .delete("/api/erp/doc?doctype=Sales+Invoice&name=INV-001")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(200);
    });

    it("returns 400 when doctype or name is missing", async () => {
      mockAuthenticatedSession();

      const res = await request(app)
        .delete("/api/erp/doc?doctype=Sales+Invoice")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/erp/dashboard ────────────────────────────────────────────────
  describe("GET /api/erp/dashboard", () => {
    it("returns 401 without a session cookie", async () => {
      const res = await request(app).get("/api/erp/dashboard");

      expect(res.status).toBe(401);
    });

    it("returns 401 with an invalid session", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "Session expired",
      });

      const res = await request(app).get("/api/erp/dashboard").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(401);
    });

    it("returns 200 with dashboard data for a valid session", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: {
          userId: "usr_1",
          accountId: "acc_1",
          role: "owner",
          erpnextSid: "erp-sid-123",
        },
      });

      const res = await request(app).get("/api/erp/dashboard").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
    });
  });
});
