import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";

// ---------------------------------------------------------------------------
// Mocks — external boundaries needed to mount createApp()
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    auditLog: { create: vi.fn() },
    webhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
    account: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("../../lib/redis.js", () => ({
  getRedis: vi.fn().mockReturnValue(null),
  getRedisConfig: vi.fn().mockReturnValue({ host: "localhost", port: 6379 }),
}));

vi.mock("../../lib/services/session.service.js", () => ({
  validateSession: vi.fn().mockResolvedValue({ ok: false, error: "no session" }),
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
  verifyPaddleWebhook: vi.fn().mockReturnValue(true),
  markAccountPaid: vi.fn().mockResolvedValue({ ok: true, data: { updated: true } }),
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

import { createApp } from "../../app.js";
import { verifyPaddleWebhook, markAccountPaid } from "../../lib/services/billing.service.js";

const app = createApp();

describe("webhooks routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/webhooks requires auth", async () => {
    const res = await supertest(app).get("/api/webhooks");
    expect([401, 404]).toContain(res.status);
  });

  it("POST /api/webhooks requires auth", async () => {
    const res = await supertest(app)
      .post("/api/webhooks")
      .send({ url: "https://example.com/hook", events: ["erp.doc_updated"] });
    expect([401, 403, 404]).toContain(res.status);
  });

  describe("POST /api/webhooks/paddle", () => {
    it("returns 401 when signature verification fails", async () => {
      (verifyPaddleWebhook as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await supertest(app)
        .post("/api/webhooks/paddle")
        .set("Paddle-Signature", "ts=123;h1=invalid")
        .send({ event_type: "transaction.completed", event_id: "evt_1" });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid signature");
    });

    it("returns 200 for valid transaction.completed event", async () => {
      (verifyPaddleWebhook as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (markAccountPaid as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { updated: true } });

      const res = await supertest(app)
        .post("/api/webhooks/paddle")
        .set("Paddle-Signature", "ts=123;h1=valid")
        .send({
          event_type: "transaction.completed",
          event_id: "evt_1",
          data: {
            id: "txn_1",
            subscription_id: "sub_1",
            custom_data: { accountId: "acc_123" },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it("returns 200 for transaction.completed without accountId", async () => {
      (verifyPaddleWebhook as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const res = await supertest(app)
        .post("/api/webhooks/paddle")
        .set("Paddle-Signature", "ts=123;h1=valid")
        .send({
          event_type: "transaction.completed",
          event_id: "evt_2",
          data: { id: "txn_1" },
        });

      expect(res.status).toBe(200);
    });

    it("returns 200 for unhandled event types", async () => {
      (verifyPaddleWebhook as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const res = await supertest(app)
        .post("/api/webhooks/paddle")
        .set("Paddle-Signature", "ts=123;h1=valid")
        .send({
          event_type: "some.unknown.event",
          event_id: "evt_3",
        });

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });
});
