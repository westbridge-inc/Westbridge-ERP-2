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
    auditLog: { create: vi.fn() },
    notificationPreference: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    apiKey: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "key_1" }),
      findFirst: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
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

vi.mock("../../lib/services/auth.service.js", () => ({ login: vi.fn() }));
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

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateSession } from "../../lib/services/session.service.js";
import { prisma } from "../../lib/data/prisma.js";

const app = createApp();
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

describe("Settings Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/settings/notifications", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).get("/api/settings/notifications");
      expect(res.status).toBe(401);
    });

    it("returns defaults when no prefs exist", async () => {
      mockSession("member");
      const res = await request(app).get("/api/settings/notifications").set("Cookie", SESSION_COOKIE);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("emailInvoices");
    });
  });

  describe("PUT /api/settings/notifications", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).put("/api/settings/notifications").send({ emailInvoices: false });
      expect(res.status).toBe(401);
    });

    it("updates preferences", async () => {
      mockSession("member");
      const res = await request(app)
        .put("/api/settings/notifications")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ emailInvoices: false });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("updated", true);
    });
  });

  describe("GET /api/settings/api-keys", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).get("/api/settings/api-keys");
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-admin", async () => {
      mockSession("member");
      const res = await request(app).get("/api/settings/api-keys").set("Cookie", SESSION_COOKIE);
      expect(res.status).toBe(403);
    });

    it("returns 200 with keys for owner", async () => {
      mockSession("owner");
      const res = await request(app).get("/api/settings/api-keys").set("Cookie", SESSION_COOKIE);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("keys");
    });
  });

  describe("POST /api/settings/api-keys", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).post("/api/settings/api-keys").send({});
      expect(res.status).toBe(401);
    });

    it("creates API key for owner", async () => {
      mockSession("owner");
      const res = await request(app)
        .post("/api/settings/api-keys")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ label: "Test key" });
      expect(res.status).toBe(201);
      expect(res.body.data).toHaveProperty("key");
      expect(res.body.data).toHaveProperty("warning");
    });
  });

  describe("DELETE /api/settings/api-keys/:id", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).delete("/api/settings/api-keys/key_1");
      expect(res.status).toBe(401);
    });

    it("returns 404 when key not found", async () => {
      mockSession("owner");
      (prisma.apiKey.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app)
        .delete("/api/settings/api-keys/key_1")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");
      expect(res.status).toBe(404);
    });

    it("revokes key for owner", async () => {
      mockSession("owner");
      (prisma.apiKey.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "key_1",
        prefix: "wb_live_...",
        accountId: "acc_1",
      });

      const res = await request(app)
        .delete("/api/settings/api-keys/key_1")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("revoked", true);
    });
  });
});
