/**
 * E2E tests — Auth flow
 *
 * Exercises the full middleware chain (CORS, helmet, cookie-parser, CSRF,
 * session validation, rate limiting) for authentication-related endpoints.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any app import so vi.mock hoisting works
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    account: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    session: { deleteMany: vi.fn() },
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
  capture: vi.fn(),
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

// ---------------------------------------------------------------------------
// Import app + mocked modules AFTER mocks are registered
// ---------------------------------------------------------------------------

import { createApp } from "../../app.js";
import { startServer } from "./setup.js";
import { prisma } from "../../lib/data/prisma.js";
import { validateCsrf } from "../../lib/csrf.js";

// ---------------------------------------------------------------------------
// Boot a real HTTP server
// ---------------------------------------------------------------------------

let request: Awaited<ReturnType<typeof startServer>>["request"];
let close: () => Promise<void>;

const app = createApp();

beforeAll(async () => {
  const srv = await startServer(app);
  request = srv.request;
  close = srv.close;
});

afterAll(async () => {
  await close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Auth flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  // ── GET /api/csrf ─────────────────────────────────────────────────────────
  describe("GET /api/csrf", () => {
    it("returns a CSRF token", async () => {
      const res = await request.get("/api/csrf");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body.data).toHaveProperty("token", "test-csrf-token");
    });
  });

  // ── POST /api/auth/login — invalid credentials ───────────────────────────
  describe("POST /api/auth/login", () => {
    it("returns 401 when account is not found (invalid creds)", async () => {
      (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request
        .post("/api/auth/login")
        .set("Cookie", "westbridge_csrf=test-csrf-token")
        .set("x-csrf-token", "test-csrf-token")
        .send({ email: "nobody@example.com", password: "wrong-password" });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error.code).toBe("AUTH_FAILED");
    });

    it("returns 403 when CSRF token is missing", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await request.post("/api/auth/login").send({ email: "user@example.com", password: "secret123" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });
  });

  // ── GET /api/health/live ──────────────────────────────────────────────────
  describe("GET /api/health/live", () => {
    it("returns 200 with alive: true", async () => {
      const res = await request.get("/api/health/live");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("alive", true);
      expect(res.body).toHaveProperty("uptime_seconds");
    });
  });
});
