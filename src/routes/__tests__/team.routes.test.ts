import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    account: { findUnique: vi.fn() },
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "usr_1",
          name: "Alice Owner",
          email: "alice@acme.com",
          role: "owner",
          status: "active",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          id: "usr_2",
          name: null,
          email: "bob@acme.com",
          role: "member",
          status: "active",
          createdAt: new Date("2026-02-01T00:00:00Z"),
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
vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
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

describe("Team Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/team", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/team");

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 200 with team members for authenticated owner", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/team").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("members");
      expect(Array.isArray(res.body.data.members)).toBe(true);
      expect(res.body.data.members).toHaveLength(2);
    });

    it("returns members with expected fields", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/team").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      const firstMember = res.body.data.members[0];
      expect(firstMember).toHaveProperty("id");
      expect(firstMember).toHaveProperty("name");
      expect(firstMember).toHaveProperty("email");
      expect(firstMember).toHaveProperty("role");
      expect(firstMember).toHaveProperty("status");
      expect(firstMember).toHaveProperty("isYou");
    });

    it("marks the current user with isYou: true", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/team").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      const currentUser = res.body.data.members.find((m: { id: string }) => m.id === "usr_1");
      expect(currentUser?.isYou).toBe(true);
    });

    it("returns 200 with team members for viewer role (users:read is granted)", async () => {
      mockSession("viewer");

      const res = await request(app).get("/api/team").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("members");
    });

    it("uses email prefix as name when name is null", async () => {
      mockSession("owner");

      const res = await request(app).get("/api/team").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      const bobMember = res.body.data.members.find((m: { id: string }) => m.id === "usr_2");
      expect(bobMember?.name).toBe("bob");
    });
  });
});
