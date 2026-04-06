import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    account: { findUnique: vi.fn() },
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

vi.mock("../../lib/services/billing.service.js", () => ({
  createAccount: vi.fn().mockResolvedValue({
    ok: true,
    data: {
      accountId: "acc_new",
      userId: "user_new",
      sessionToken: "session-token-abc",
      status: "active",
    },
  }),
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
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateCsrf } from "../../lib/csrf.js";
import { createAccount } from "../../lib/services/billing.service.js";

const app = createApp();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CSRF_COOKIE = "westbridge_csrf=test-csrf-token";

const VALID_SIGNUP = {
  email: "newuser@acme.com",
  name: "New User",
  password: "password123",
  companyName: "Acme Corp",
  plan: "Starter",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Signup Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  describe("POST /api/signup", () => {
    it("returns 400 for missing fields (empty body)", async () => {
      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 400 for missing email", async () => {
      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ companyName: "Acme Corp", plan: "Starter" });

      expect(res.status).toBe(400);
    });

    it("returns 400 for missing companyName", async () => {
      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "user@acme.com", plan: "Starter" });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid email format", async () => {
      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "not-an-email", companyName: "Acme", plan: "Starter" });

      expect(res.status).toBe(400);
    });

    it("returns 403 when CSRF token is missing", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request(app).post("/api/signup").send(VALID_SIGNUP);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("returns 400 for disposable email domain", async () => {
      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({
          email: "user@mailinator.com",
          name: "Spammer",
          password: "password123",
          companyName: "Spammer Inc",
          plan: "Starter",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("Disposable");
    });

    it("returns 400 for another disposable domain (yopmail.com)", async () => {
      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send({
          email: "test@yopmail.com",
          name: "Tester",
          password: "password123",
          companyName: "Test Corp",
          plan: "Starter",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("Disposable");
    });

    it("returns 200 for valid signup", async () => {
      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send(VALID_SIGNUP);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("accountId", "acc_new");
      expect(res.body.data).toHaveProperty("sessionToken");
      expect(res.body.data).toHaveProperty("status", "active");
    });

    it("returns 409 when email already exists", async () => {
      (createAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "An account with this email already exists. Please sign in.",
      });

      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send(VALID_SIGNUP);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("SIGNUP_FAILED");
    });

    it("returns 500 for unexpected billing service error", async () => {
      (createAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        error: "Unexpected billing error",
      });

      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send(VALID_SIGNUP);

      expect(res.status).toBe(500);
    });

    it("includes meta with request_id in the response", async () => {
      const res = await request(app)
        .post("/api/signup")
        .set("Cookie", CSRF_COOKIE)
        .set("x-csrf-token", "test-csrf-token")
        .send(VALID_SIGNUP);

      expect(res.body).toHaveProperty("meta");
      expect(res.body.meta).toHaveProperty("request_id");
    });
  });
});
