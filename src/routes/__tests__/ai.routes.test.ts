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
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
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

vi.mock("../../lib/services/auth.service.js", () => ({
  login: vi.fn(),
}));
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

// AI-specific external boundary mocks
vi.mock("../../lib/ai/claude.js", () => ({
  anthropic: null,
  AI_MODELS: { chat: "claude-sonnet-4-5", analysis: "claude-opus-4-5" },
  hasUnlimitedAi: vi.fn(),
  isAiConfigured: vi.fn().mockReturnValue(false),
}));
vi.mock("../../lib/ai/tools.js", () => ({
  ERP_TOOLS: [],
  executeTool: vi.fn(),
}));
vi.mock("../../lib/ai/context.js", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("system prompt"),
}));
vi.mock("../../lib/ai/limits.js", () => ({
  checkAiLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, usage: { queries: 0, tokens: 0 }, remaining: { queries: 50, tokens: 100000 } }),
  recordAiUsage: vi.fn(),
  getAiUsage: vi.fn().mockResolvedValue({ queries: 5, tokens: 10000 }),
}));

// ---------------------------------------------------------------------------
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateSession } from "../../lib/services/session.service.js";
import { prisma } from "../../lib/data/prisma.js";

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

describe("AI Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/ai/chat", () => {
    it("returns 200 with AI not configured message when anthropic is null", async () => {
      const res = await request(app)
        .post("/api/ai/chat")
        .set("Cookie", `${SESSION_COOKIE}; westbridge_csrf=test-csrf-token`)
        .set("x-csrf-token", "test-csrf-token")
        .send({ message: "Hello", module: "general" });

      // anthropic is null, so it should return graceful degradation
      expect(res.status).toBe(200);
      expect(res.body.data.reply).toContain("not configured");
    });
  });

  describe("GET /api/ai/usage", () => {
    it("returns 401 without session", async () => {
      const res = await request(app).get("/api/ai/usage");
      expect(res.status).toBe(401);
    });

    it("returns 200 with usage data", async () => {
      mockSession("member");
      (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: "Starter",
      });

      const res = await request(app).get("/api/ai/usage").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("ai");
    });

    it("returns 404 when account not found", async () => {
      mockSession("member");
      (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await request(app).get("/api/ai/usage").set("Cookie", SESSION_COOKIE);

      expect(res.status).toBe(404);
    });
  });
});
