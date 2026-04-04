import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — external boundaries needed to mount createApp()
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    account: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    ssoConfig: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
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
// SSO routes use encryption (needs ENCRYPTION_KEY env var)
vi.mock("../../lib/encryption.js", () => ({
  encrypt: vi.fn().mockReturnValue("encrypted"),
  decrypt: vi.fn().mockReturnValue("decrypted"),
}));
vi.mock("../../lib/services/sso.service.js", () => ({
  buildAuthorizationUrl: vi.fn().mockResolvedValue({ ok: false, error: "not configured" }),
  handleCallback: vi.fn().mockResolvedValue({ ok: false, error: "invalid" }),
  findOrCreateSsoUser: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateSession } from "../../lib/services/session.service.js";

const app = createApp();
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

describe("SSO Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/sso/authorize", () => {
    it("returns 400 without account_id", async () => {
      const res = await request(app).get("/api/sso/authorize");
      expect(res.status).toBe(400);
    });

    it("returns 404 when SSO not configured", async () => {
      const res = await request(app).get("/api/sso/authorize?account_id=acc_1");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/sso/callback", () => {
    it("redirects on error from IdP", async () => {
      const res = await request(app).get("/api/sso/callback?error=access_denied");
      expect(res.status).toBe(302);
    });

    it("redirects on missing code/state", async () => {
      const res = await request(app).get("/api/sso/callback");
      expect(res.status).toBe(302);
    });

    it("redirects on missing accountId in state", async () => {
      const res = await request(app).get("/api/sso/callback?code=abc&state=:");
      expect(res.status).toBe(302);
    });
  });

  describe("GET /api/sso/config", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/sso/config");
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-admin", async () => {
      mockSession("member");
      const res = await request(app).get("/api/sso/config").set("Cookie", SESSION_COOKIE);
      expect(res.status).toBe(403);
    });

    it("returns 200 with not configured for owner", async () => {
      mockSession("owner");
      const res = await request(app).get("/api/sso/config").set("Cookie", SESSION_COOKIE);
      expect(res.status).toBe(200);
      expect(res.body.data.configured).toBe(false);
    });
  });

  describe("PUT /api/sso/config", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).put("/api/sso/config").send({});
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-admin", async () => {
      mockSession("member");
      const res = await request(app)
        .put("/api/sso/config")
        .set("Cookie", `${SESSION_COOKIE}; westbridge_csrf=test-csrf-token`)
        .set("x-csrf-token", "test-csrf-token")
        .send({});
      expect(res.status).toBe(403);
    });
  });
});
