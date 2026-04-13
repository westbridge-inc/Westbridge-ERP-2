import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — external boundaries needed to mount createApp
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    account: { findUnique: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ email: "test@test.com" }) },
    auditLog: { create: vi.fn() },
    totpSecret: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
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
// TOTP routes use encryption (needs ENCRYPTION_KEY env var).
// ENCRYPTION_CONTEXT is imported by the routes for AAD-bound v1 envelopes;
// the helper values themselves don't matter for these tests since encrypt/
// decrypt are mocked, but the property must exist on the module surface.
vi.mock("../../lib/encryption.js", () => ({
  encrypt: vi.fn().mockReturnValue("encrypted"),
  decrypt: vi.fn().mockReturnValue("JBSWY3DPEHPK3PXP"),
  ENCRYPTION_CONTEXT: {
    totpSecret: (userId: string) => `totp.secret:${userId}`,
    ssoClientSecret: (accountId: string) => `sso.clientSecret:${accountId}`,
    sessionErpnextSid: (userId: string) => `session.erpnextSid:${userId}`,
    webhookSecret: (endpointId: string) => `webhook.secret:${endpointId}`,
  },
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

describe("TOTP Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/auth/2fa/setup", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).post("/api/auth/2fa/setup");
      expect(res.status).toBe(401);
    });

    it("returns 200 with secret for authenticated user", async () => {
      mockSession("member");

      const res = await request(app)
        .post("/api/auth/2fa/setup")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("secret");
      expect(res.body.data).toHaveProperty("otpauthUri");
      expect(res.body.data).toHaveProperty("backupCodes");
    });

    it("returns 400 if 2FA already enabled", async () => {
      mockSession("member");
      (prisma.totpSecret.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        verified: true,
      });

      const res = await request(app)
        .post("/api/auth/2fa/setup")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/auth/2fa/verify", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).post("/api/auth/2fa/verify").send({ code: "123456" });
      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid code format", async () => {
      mockSession("member");

      const res = await request(app)
        .post("/api/auth/2fa/verify")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ code: "abc" });

      expect(res.status).toBe(400);
    });

    it("returns 400 or 401 if TOTP not set up", async () => {
      mockSession("member");

      const res = await request(app)
        .post("/api/auth/2fa/verify")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ code: "123456" });

      expect([400, 401]).toContain(res.status);
    });
  });

  describe("POST /api/auth/2fa/disable", () => {
    it("returns 401 without authentication", async () => {
      const res = await request(app).post("/api/auth/2fa/disable");
      expect(res.status).toBe(401);
    });

    it("returns 200 for authenticated user", async () => {
      mockSession("member");

      const res = await request(app)
        .post("/api/auth/2fa/disable")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("disabled", true);
    });
  });

  describe("POST /api/auth/2fa/recover", () => {
    // SHA-256("a1b2c3d4") — used by every recovery test as the "good" code.
    const GOOD_CODE = "a1b2c3d4";

    // Reset the totpSecret.findUnique mock between every recovery test so
    // state from earlier describe blocks (which leave it set to { verified:
    // true } with no backupCodes field) cannot leak into validation tests
    // and turn an expected 400 into a 500.
    beforeEach(() => {
      (prisma.totpSecret.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    });

    it("returns 401 without authentication", async () => {
      const res = await request(app).post("/api/auth/2fa/recover").send({ code: GOOD_CODE });
      expect(res.status).toBe(401);
    });

    it("returns 400 when code format is invalid", async () => {
      mockSession("member");

      // None of these are 8 hex chars after trim:
      // - "short": 5 chars
      // - "TOOLONGCODE": 11 chars (after lowercase still 11)
      // - "ghijklmn": 8 chars but g/h/i/j/k/l/m/n are not hex
      // - "1234567": 7 chars
      // - "":       0 chars
      const cases = ["short", "TOOLONGCODE", "ghijklmn", "1234567", ""];
      for (const code of cases) {
        const res = await request(app)
          .post("/api/auth/2fa/recover")
          .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
          .set("x-csrf-token", "test-csrf-token")
          .send({ code });
        expect(res.status).toBe(400);
      }
    });

    it("returns 400 when 2FA not enabled (no totpSecret row)", async () => {
      mockSession("member");
      (prisma.totpSecret.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/auth/2fa/recover")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ code: GOOD_CODE });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("NOT_ENABLED");
    });

    it("returns 400 when 2FA setup is incomplete (verified=false)", async () => {
      mockSession("member");
      (prisma.totpSecret.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        verified: false,
        backupCodes: [],
      });

      const res = await request(app)
        .post("/api/auth/2fa/recover")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ code: GOOD_CODE });

      expect(res.status).toBe(400);
    });

    it("returns 401 when code does not match any stored hash", async () => {
      mockSession("member");
      (prisma.totpSecret.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        verified: true,
        backupCodes: ["deadbeef".repeat(8)], // 64 hex chars, valid SHA-256 shape, won't match
      });

      const res = await request(app)
        .post("/api/auth/2fa/recover")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ code: GOOD_CODE });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CODE");
      // Critical: do NOT mutate the stored array on a miss
      expect(prisma.totpSecret.update).not.toHaveBeenCalled();
    });

    it("succeeds when code matches and removes that hash from the array", async () => {
      mockSession("member");
      const { createHash } = await import("crypto");
      const hash = createHash("sha256").update(GOOD_CODE).digest("hex");
      // Store this code's hash plus three decoys
      (prisma.totpSecret.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        verified: true,
        backupCodes: [hash, "decoy1".padEnd(64, "0"), "decoy2".padEnd(64, "0"), "decoy3".padEnd(64, "0")],
      });

      const res = await request(app)
        .post("/api/auth/2fa/recover")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ code: GOOD_CODE });

      expect(res.status).toBe(200);
      expect(res.body.data.recovered).toBe(true);
      expect(res.body.data.remainingCodes).toBe(3);
      // The redeemed hash MUST be removed from the persisted array
      expect(prisma.totpSecret.update).toHaveBeenCalledWith({
        where: { userId: "usr_1" },
        data: {
          backupCodes: ["decoy1".padEnd(64, "0"), "decoy2".padEnd(64, "0"), "decoy3".padEnd(64, "0")],
        },
      });
    });

    it("warns when remaining codes is low (≤2)", async () => {
      mockSession("member");
      const { createHash } = await import("crypto");
      const hash = createHash("sha256").update(GOOD_CODE).digest("hex");
      (prisma.totpSecret.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        verified: true,
        backupCodes: [hash, "decoy".padEnd(64, "0")],
      });

      const res = await request(app)
        .post("/api/auth/2fa/recover")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ code: GOOD_CODE });

      expect(res.status).toBe(200);
      expect(res.body.data.remainingCodes).toBe(1);
      expect(res.body.data.warning).toContain("1 backup codes remain");
    });

    it("warns hard when last code is consumed", async () => {
      mockSession("member");
      const { createHash } = await import("crypto");
      const hash = createHash("sha256").update(GOOD_CODE).digest("hex");
      (prisma.totpSecret.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        verified: true,
        backupCodes: [hash],
      });

      const res = await request(app)
        .post("/api/auth/2fa/recover")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ code: GOOD_CODE });

      expect(res.status).toBe(200);
      expect(res.body.data.remainingCodes).toBe(0);
      expect(res.body.data.warning).toContain("last backup code");
    });

    it("normalises uppercase / whitespace in supplied code", async () => {
      mockSession("member");
      const { createHash } = await import("crypto");
      const hash = createHash("sha256").update(GOOD_CODE).digest("hex");
      (prisma.totpSecret.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        verified: true,
        backupCodes: [hash],
      });

      const res = await request(app)
        .post("/api/auth/2fa/recover")
        .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ code: "  A1B2C3D4  " });

      expect(res.status).toBe(200);
      expect(res.body.data.recovered).toBe(true);
    });
  });
});
