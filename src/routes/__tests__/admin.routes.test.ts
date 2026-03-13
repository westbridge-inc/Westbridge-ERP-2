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
    webhookEndpoint: {
      findFirst: vi.fn(),
      update: vi.fn(),
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

vi.mock("../../lib/feature-flags.js", () => ({
  getAllFlags: vi
    .fn()
    .mockResolvedValue([{ key: "dark_mode", defaultValue: false, description: "Dark mode toggle", rules: [] }]),
  setFlag: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/jobs/queue.js", () => {
  const makeQueue = () => ({
    getWaitingCount: vi.fn().mockResolvedValue(0),
    getActiveCount: vi.fn().mockResolvedValue(0),
    getCompletedCount: vi.fn().mockResolvedValue(5),
    getFailedCount: vi.fn().mockResolvedValue(0),
    getFailed: vi.fn().mockResolvedValue([]),
    getWaiting: vi.fn().mockResolvedValue([]),
    getJob: vi.fn().mockResolvedValue(null),
  });
  return {
    emailQueue: makeQueue(),
    erpSyncQueue: makeQueue(),
    reportsQueue: makeQueue(),
    cleanupQueue: makeQueue(),
  };
});

vi.mock("../../lib/api/cache-headers.js", () => ({
  cacheControl: {
    private: vi.fn().mockReturnValue("private, no-cache"),
  },
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
import { validateCsrf } from "../../lib/csrf.js";

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

describe("Admin Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  // ── GET /api/admin/flags ──────────────────────────────────────────────────
  describe("GET /api/admin/flags", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/admin/flags");

      expect(res.status).toBe(401);
    });

    it("returns 403 without admin/owner role", async () => {
      mockSession("member");

      const res = await request(app).get("/api/admin/flags").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("returns 403 for viewer role", async () => {
      mockSession("viewer");

      const res = await request(app).get("/api/admin/flags").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
    });

    it("returns 403 for manager role (only owner has admin:*)", async () => {
      mockSession("manager");

      const res = await request(app).get("/api/admin/flags").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
    });

    it("returns 200 with flags for owner role", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/admin/flags").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ── PUT /api/admin/flags ──────────────────────────────────────────────────
  describe("PUT /api/admin/flags", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app)
        .put("/api/admin/flags")
        .send({ key: "test", defaultValue: true, description: "test flag", rules: [] });

      expect(res.status).toBe(401);
    });

    it("returns 403 without owner role", async () => {
      mockSession("admin");

      const res = await request(app)
        .put("/api/admin/flags")
        .set("Cookie", SESSION_COOKIE)
        .send({ key: "test", defaultValue: true, description: "test flag", rules: [] });

      expect(res.status).toBe(403);
    });

    it("returns 403 when CSRF is invalid", async () => {
      mockSession("owner");
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app)
        .put("/api/admin/flags")
        .set("Cookie", SESSION_COOKIE)
        .send({ key: "test", defaultValue: true, description: "test flag", rules: [] });

      expect(res.status).toBe(403);
    });

    it("returns 200 for valid flag update by owner", async () => {
      mockSession("owner");

      const res = await request(app)
        .put("/api/admin/flags")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({
          key: "dark_mode",
          defaultValue: true,
          description: "Enable dark mode",
          rules: [],
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("updated", true);
    });

    it("returns 400 for empty body", async () => {
      mockSession("owner");

      const res = await request(app)
        .put("/api/admin/flags")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/admin/jobs ───────────────────────────────────────────────────
  describe("GET /api/admin/jobs", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/admin/jobs");

      expect(res.status).toBe(401);
    });

    it("returns 403 without owner role", async () => {
      mockSession("member");

      const res = await request(app).get("/api/admin/jobs").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
    });

    it("returns 200 with queue stats for owner", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/admin/jobs").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("queues");
      expect(Array.isArray(res.body.data.queues)).toBe(true);
      expect(res.body.data.queues.length).toBe(4);
    });
  });
});
