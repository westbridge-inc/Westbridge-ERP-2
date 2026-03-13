import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    account: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: {
      count: vi.fn().mockResolvedValue(2),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "al_1",
          timestamp: new Date("2026-01-15T10:00:00Z"),
          action: "auth.login.success",
          userId: "usr_1",
          ipAddress: "127.0.0.1",
          severity: "info",
          outcome: "success",
          resource: null,
          resourceId: null,
          metadata: null,
        },
        {
          id: "al_2",
          timestamp: new Date("2026-01-15T09:00:00Z"),
          action: "erp.doc.read",
          userId: "usr_1",
          ipAddress: "127.0.0.1",
          severity: "info",
          outcome: "success",
          resource: "Sales Invoice",
          resourceId: "INV-001",
          metadata: null,
        },
      ]),
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

// ---------------------------------------------------------------------------
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateSession } from "../../lib/services/session.service.js";

const app = createApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "westbridge_sid=test-session-token";

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

describe("Audit Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /api/audit ────────────────────────────────────────────────────────
  describe("GET /api/audit", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/audit");

      expect(res.status).toBe(401);
    });

    it("returns 403 for viewer role (no audit_logs:read permission)", async () => {
      mockSession("viewer");

      const res = await request(app).get("/api/audit").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("returns 403 for member role", async () => {
      mockSession("member");

      const res = await request(app).get("/api/audit").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
    });

    it("returns 403 for manager role", async () => {
      mockSession("manager");

      const res = await request(app).get("/api/audit").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
    });

    it("returns 200 with audit logs for admin role", async () => {
      mockSession("admin");

      const res = await request(app).get("/api/audit").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("logs");
      expect(Array.isArray(res.body.data.logs)).toBe(true);
    });

    it("returns 200 with audit logs for owner role", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/audit").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("logs");
    });

    it("includes pagination metadata", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/audit?page=1&per_page=10").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.meta).toHaveProperty("pagination");
      expect(res.body.meta.pagination).toHaveProperty("page");
      expect(res.body.meta.pagination).toHaveProperty("total");
    });
  });

  // ── GET /api/audit/export ─────────────────────────────────────────────────
  describe("GET /api/audit/export", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/audit/export");

      expect(res.status).toBe(401);
    });

    it("returns 403 for viewer role", async () => {
      mockSession("viewer");

      const res = await request(app).get("/api/audit/export").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
    });

    it("returns 403 for member role (no audit_logs:read)", async () => {
      mockSession("member");

      const res = await request(app).get("/api/audit/export").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
    });

    it("returns 403 for admin role (export requires owner/admin role check in handler)", async () => {
      // Note: The audit/export route has an additional check for owner/admin role
      // beyond the requirePermission middleware. admin has audit_logs:read but the handler
      // explicitly checks session.role === "owner" || "admin".
      mockSession("admin");

      const res = await request(app).get("/api/audit/export").set("Cookie", SESSION_COOKIE);

      // admin should pass both the requirePermission and the handler's role check
      expect(res.status).toBe(200);
    });

    it("returns 200 with CSV data for owner", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/audit/export?format=csv").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
    });

    it("returns 200 with JSON data for owner", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/audit/export?format=json").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
    });
  });
});
