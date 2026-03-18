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
      findUnique: vi.fn().mockResolvedValue({ id: "acc_1", companyName: "Test Co" }),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: "usr_1", name: "Test User", email: "test@co.com" }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(1),
      update: vi.fn().mockResolvedValue({}),
    },
    session: {
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    inviteToken: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
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
  revokeSession: vi.fn(),
  revokeAllUserSessions: vi.fn().mockResolvedValue({ ok: true, data: { count: 1 } }),
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
  hashPassword: vi.fn().mockResolvedValue("hashed-password"),
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
  validateInviteToken: vi.fn(),
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
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateSession } from "../../lib/services/session.service.js";
import { validateCsrf } from "../../lib/csrf.js";
import { createInvite, acceptInvite, validateInviteToken } from "../../lib/services/invite.service.js";

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

describe("Invite Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  // ── POST /api/invite ──────────────────────────────────────────────────────
  describe("POST /api/invite", () => {
    it("returns 401 without session cookie", async () => {
      const res = await request(app)
        .post("/api/invite")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "new@test.com", role: "member" });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid email", async () => {
      mockSession("owner");

      const res = await request(app)
        .post("/api/invite")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "not-an-email", role: "member" });

      expect(res.status).toBe(400);
    });

    it("returns 400 for empty body", async () => {
      mockSession("owner");

      const res = await request(app)
        .post("/api/invite")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 200 on successful invite", async () => {
      mockSession("owner");
      (createInvite as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { sent: true } });

      const res = await request(app)
        .post("/api/invite")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "new@test.com", role: "member" });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("sent", true);
    });
  });

  // ── GET /api/invite ───────────────────────────────────────────────────────
  describe("GET /api/invite", () => {
    it("returns 400 when token query param is missing", async () => {
      const res = await request(app).get("/api/invite");

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BAD_REQUEST");
    });

    it("returns 400 for invalid/expired token", async () => {
      (validateInviteToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "Invalid or expired invite link.",
      });

      const res = await request(app).get("/api/invite?token=bad-token");

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_TOKEN");
    });

    it("returns 200 with invite details for valid token", async () => {
      (validateInviteToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: {
          inviteId: "inv_1",
          accountId: "acc_1",
          email: "invited@test.com",
          role: "member",
        },
      });

      const res = await request(app).get("/api/invite?token=valid-token");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("email", "invited@test.com");
      expect(res.body.data).toHaveProperty("role", "member");
      expect(res.body.data).toHaveProperty("companyName", "Test Co");
    });
  });

  // ── POST /api/invite/accept ───────────────────────────────────────────────
  describe("POST /api/invite/accept", () => {
    it("returns 400 for empty body", async () => {
      const res = await request(app)
        .post("/api/invite/accept")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 400 for missing required fields", async () => {
      const res = await request(app)
        .post("/api/invite/accept")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ token: "abc" });

      expect(res.status).toBe(400);
    });

    it("returns 403 when CSRF is invalid", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app)
        .post("/api/invite/accept")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "bad-token")
        .send({ token: "abc", name: "Test", password: "StrongP@ss1!" });

      expect(res.status).toBe(403);
    });

    it("returns 400 for invalid/expired invite token", async () => {
      (validateInviteToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "This invite link has expired.",
      });

      const res = await request(app)
        .post("/api/invite/accept")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ token: "expired-token", name: "New User", password: "StrongP@ss1!" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_TOKEN");
    });

    it("returns 502 when ERPNext password update fails", async () => {
      (validateInviteToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: {
          inviteId: "inv_1",
          accountId: "acc_1",
          email: "invited@test.com",
          role: "member",
        },
      });

      // Mock global fetch to simulate ERPNext failure
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

      const res = await request(app)
        .post("/api/invite/accept")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ token: "valid-token", name: "New User", password: "StrongP@ss1!" });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe("ERP_ERROR");

      globalThis.fetch = originalFetch;
    });

    it("returns 200 on successful invite acceptance", async () => {
      (validateInviteToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: {
          inviteId: "inv_1",
          accountId: "acc_1",
          email: "invited@test.com",
          role: "member",
        },
      });
      (acceptInvite as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: { userId: "usr_new", accountId: "acc_1" },
      });

      // Mock global fetch to simulate ERPNext success
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      const res = await request(app)
        .post("/api/invite/accept")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ token: "valid-token", name: "New User", password: "StrongP@ss1!" });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("success", true);

      globalThis.fetch = originalFetch;
    });
  });
});
