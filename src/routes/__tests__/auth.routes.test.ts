import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    account: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    session: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../../lib/redis.js", () => ({
  getRedis: vi.fn().mockReturnValue(null),
  getRedisConfig: vi.fn().mockReturnValue({ host: "localhost", port: 6379 }),
}));

vi.mock("../../lib/services/session.service.js", () => ({
  validateSession: vi.fn(),
  createSession: vi.fn(),
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
  login: vi.fn(),
}));

vi.mock("../../lib/services/password-reset.service.js", () => ({
  requestPasswordReset: vi.fn().mockResolvedValue({ ok: true, data: { sent: true } }),
  applyPasswordReset: vi.fn().mockResolvedValue({ ok: true, data: { success: true } }),
}));

vi.mock("../../lib/password-policy.js", () => ({
  validatePassword: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}));

vi.mock("../../lib/analytics/posthog.server.js", () => ({
  identify: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
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

// ---------------------------------------------------------------------------
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateSession, createSession } from "../../lib/services/session.service.js";
import { login } from "../../lib/services/auth.service.js";
import { prisma } from "../../lib/data/prisma.js";
import { validateCsrf } from "../../lib/csrf.js";

const app = createApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "westbridge_sid=test-session-token";
const CSRF_COOKIE = "westbridge_csrf=test-csrf-token";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Auth Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: CSRF passes
    (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  // ── POST /api/auth/login ─────────────────────────────────────────────────
  describe("POST /api/auth/login", () => {
    it("returns 400 for missing email field", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ password: "secret123" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 for missing password field", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "user@example.com" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 for invalid email format", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "not-an-email", password: "secret123" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 403 when CSRF token is missing", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app).post("/api/auth/login").send({ email: "user@example.com", password: "secret123" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("returns 401 when account is not found", async () => {
      (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "user@example.com", password: "secret123" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_FAILED");
    });

    it("returns 401 when login fails (bad credentials)", async () => {
      (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "acc_1",
        email: "user@example.com",
        plan: "starter",
        companyName: "Test Corp",
      });
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "usr_1",
        accountId: "acc_1",
        email: "user@example.com",
        role: "owner",
        status: "active",
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
      (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (login as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "Invalid credentials",
      });

      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "user@example.com", password: "wrongpassword" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_FAILED");
    });

    it("returns 200 with success on valid login", async () => {
      (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "acc_1",
        email: "user@example.com",
        plan: "starter",
        companyName: "Test Corp",
      });
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "usr_1",
        accountId: "acc_1",
        email: "user@example.com",
        name: "Test User",
        role: "owner",
        status: "active",
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
      (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (login as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: "erp-session-id",
      });
      (createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: {
          token: "new-session-token",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "user@example.com", password: "correct-password" });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("success", true);
      // Verify session cookie is set
      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const sessionCookie = Array.isArray(cookies)
        ? cookies.find((c: string) => c.startsWith("westbridge_sid="))
        : cookies;
      expect(sessionCookie).toBeDefined();
    });

    it("returns 423 when account is locked", async () => {
      (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "acc_1",
        email: "user@example.com",
        plan: "starter",
        companyName: "Test Corp",
      });
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "usr_1",
        accountId: "acc_1",
        email: "user@example.com",
        role: "owner",
        status: "active",
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000), // locked for 15 min
      });

      const res = await request(app)
        .post("/api/auth/login")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "user@example.com", password: "secret123" });

      expect(res.status).toBe(423);
      expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
    });
  });

  // ── POST /api/auth/logout ────────────────────────────────────────────────
  describe("POST /api/auth/logout", () => {
    it("returns 200 and clears cookies on successful logout", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      });

      const res = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("loggedOut", true);
    });

    it("returns 200 even without a session cookie (no-op logout)", async () => {
      const res = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("loggedOut", true);
    });

    it("returns 403 when CSRF token is invalid", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app).post("/api/auth/logout").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });
  });

  // ── GET /api/auth/validate ───────────────────────────────────────────────
  describe("GET /api/auth/validate", () => {
    it("returns 401 without a session cookie", async () => {
      const res = await request(app).get("/api/auth/validate");

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 401 with an invalid session", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "Session expired",
      });

      const res = await request(app).get("/api/auth/validate").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(401);
    });

    it("returns 200 with user data for a valid session", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      });
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        name: "Test User",
        email: "user@example.com",
      });

      const res = await request(app).get("/api/auth/validate").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("userId", "usr_1");
      expect(res.body.data).toHaveProperty("accountId", "acc_1");
      expect(res.body.data).toHaveProperty("role", "owner");
      expect(res.body.data).toHaveProperty("email", "user@example.com");
      expect(res.body.data).toHaveProperty("name", "Test User");
    });
  });

  // ── POST /api/auth/forgot-password ───────────────────────────────────────
  describe("POST /api/auth/forgot-password", () => {
    it("returns 200 for a valid email (no enumeration)", async () => {
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "user@example.com" });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("sent", true);
    });

    it("returns 200 even for a non-existent email (anti-enumeration)", async () => {
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "nonexistent@example.com" });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("sent", true);
    });

    it("returns 400 for an invalid email format", async () => {
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "not-an-email" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 403 when CSRF is invalid", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app).post("/api/auth/forgot-password").send({ email: "user@example.com" });

      expect(res.status).toBe(403);
    });
  });

  // ── POST /api/auth/reset-password ────────────────────────────────────────
  describe("POST /api/auth/reset-password", () => {
    it("returns 400 for missing fields", async () => {
      const res = await request(app)
        .post("/api/auth/reset-password")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 400 for missing password", async () => {
      const res = await request(app)
        .post("/api/auth/reset-password")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ token: "some-token" });

      expect(res.status).toBe(400);
    });

    it("returns 403 when CSRF is invalid", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: "some-token", password: "NewPass123!@#" });

      expect(res.status).toBe(403);
    });

    it("returns 200 for valid reset request", async () => {
      const { applyPasswordReset } = await import("../../lib/services/password-reset.service.js");
      (applyPasswordReset as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: { success: true },
      });

      const res = await request(app)
        .post("/api/auth/reset-password")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ token: "valid-reset-token", password: "NewPass123!@#" });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("success", true);
    });
  });

  // ── POST /api/auth/change-password ───────────────────────────────────────
  describe("POST /api/auth/change-password", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({
          currentPassword: "oldpass",
          newPassword: "NewPass123!@#",
        });

      expect(res.status).toBe(401);
    });

    it("returns 403 when CSRF is invalid", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app).post("/api/auth/change-password").set("Cookie", SESSION_COOKIE).send({
        currentPassword: "oldpass",
        newPassword: "NewPass123!@#",
      });

      expect(res.status).toBe(403);
    });

    it("returns 400 when passwords are missing", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: { userId: "usr_1", accountId: "acc_1", role: "owner" },
      });

      const res = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({});

      expect(res.status).toBe(400);
    });
  });
});
