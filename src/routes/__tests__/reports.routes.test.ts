import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the app
// ---------------------------------------------------------------------------

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    auditLog: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../../lib/redis.js", () => ({
  getRedis: vi.fn().mockReturnValue({
    ping: vi.fn().mockResolvedValue("PONG"),
  }),
  getRedisConfig: vi.fn().mockReturnValue({ host: "localhost", port: 6379 }),
}));

vi.mock("../../lib/services/session.service.js", () => ({
  validateSession: vi.fn(),
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
    add: vi.fn().mockResolvedValue({ id: "test-job-123" }),
  });
  return {
    emailQueue: makeQueue(),
    erpSyncQueue: makeQueue(),
    reportsQueue: makeQueue(),
    cleanupQueue: makeQueue(),
    webhooksQueue: makeQueue(),
    enqueueEmail: vi.fn(),
    enqueueReport: vi.fn().mockResolvedValue("test-job-123"),
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

// Mock the workers export to avoid BullMQ worker instantiation
vi.mock("../../workers/index.js", () => ({
  SUPPORTED_REPORT_TYPES: ["revenue_summary", "audit_export", "user_activity"],
  startWorkers: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Import app AFTER mocks
// ---------------------------------------------------------------------------
import { createApp } from "../../app.js";
import { validateSession } from "../../lib/services/session.service.js";
import { validateCsrf } from "../../lib/csrf.js";
import { enqueueReport, reportsQueue } from "../../lib/jobs/queue.js";
import { prisma } from "../../lib/data/prisma.js";
import { checkTieredRateLimit } from "../../lib/api/rate-limit-tiers.js";

const app = createApp();

// Helper: set up authenticated session
function mockAuth(role = "admin") {
  (validateSession as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    data: { userId: "user-1", accountId: "acct-1", role },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reports Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth("admin");
  });

  // ── POST /api/reports ───────────────────────────────────────────────────
  describe("POST /api/reports", () => {
    it("returns 202 with job ID when report is enqueued", async () => {
      const res = await request(app)
        .post("/api/reports")
        .set("Cookie", "westbridge_sid=valid-token")
        .set("X-CSRF-Token", "valid-csrf")
        .send({ reportType: "revenue_summary", params: { period: "2026-02" } });

      expect(res.status).toBe(202);
      expect(res.body.data).toHaveProperty("jobId", "test-job-123");
      expect(res.body.data).toHaveProperty("status", "queued");
      expect(res.body.data).toHaveProperty("reportType", "revenue_summary");
      expect(enqueueReport).toHaveBeenCalledWith({
        accountId: "acct-1",
        reportType: "revenue_summary",
        params: { period: "2026-02" },
        requestedBy: "user-1",
      });
    });

    it("returns 400 for invalid report type", async () => {
      const res = await request(app)
        .post("/api/reports")
        .set("Cookie", "westbridge_sid=valid-token")
        .set("X-CSRF-Token", "valid-csrf")
        .send({ reportType: "nonexistent_report" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_REPORT_TYPE");
    });

    it("returns 400 for missing reportType", async () => {
      const res = await request(app)
        .post("/api/reports")
        .set("Cookie", "westbridge_sid=valid-token")
        .set("X-CSRF-Token", "valid-csrf")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 403 when CSRF validation fails", async () => {
      (validateCsrf as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

      const res = await request(app)
        .post("/api/reports")
        .set("Cookie", "westbridge_sid=valid-token")
        .send({ reportType: "revenue_summary" });

      expect(res.status).toBe(403);
    });

    it("returns 401 when not authenticated", async () => {
      (validateSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        error: "Invalid session",
      });

      const res = await request(app)
        .post("/api/reports")
        .set("Cookie", "westbridge_sid=invalid")
        .send({ reportType: "revenue_summary" });

      expect(res.status).toBe(401);
    });

    it("returns 403 when user lacks reports:create permission", async () => {
      mockAuth("viewer");

      const res = await request(app)
        .post("/api/reports")
        .set("Cookie", "westbridge_sid=valid-token")
        .set("X-CSRF-Token", "valid-csrf")
        .send({ reportType: "revenue_summary" });

      expect(res.status).toBe(403);
    });

    it("returns 429 when rate limited", async () => {
      (checkTieredRateLimit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ allowed: false });

      const res = await request(app)
        .post("/api/reports")
        .set("Cookie", "westbridge_sid=valid-token")
        .set("X-CSRF-Token", "valid-csrf")
        .send({ reportType: "revenue_summary" });

      expect(res.status).toBe(429);
    });

    it("returns 503 when queue is full", async () => {
      (enqueueReport as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Report service temporarily unavailable — queue capacity reached"),
      );

      const res = await request(app)
        .post("/api/reports")
        .set("Cookie", "westbridge_sid=valid-token")
        .set("X-CSRF-Token", "valid-csrf")
        .send({ reportType: "revenue_summary" });

      expect(res.status).toBe(503);
    });
  });

  // ── GET /api/reports ────────────────────────────────────────────────────
  describe("GET /api/reports", () => {
    it("returns 200 with paginated list of completed reports", async () => {
      mockAuth("manager");
      const mockReports = [
        {
          id: "log-1",
          resource: "revenue_summary",
          resourceId: "job-1",
          userId: "user-1",
          metadata: { reportType: "revenue_summary", period: "2026-02" },
          timestamp: new Date("2026-03-01"),
        },
      ];
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
      (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReports);

      const res = await request(app).get("/api/reports").set("Cookie", "westbridge_sid=valid-token");

      expect(res.status).toBe(200);
      expect(res.body.data.reports).toHaveLength(1);
      expect(res.body.data.reports[0]).toHaveProperty("reportType", "revenue_summary");
      expect(res.body.data.reports[0]).toHaveProperty("jobId", "job-1");
      expect(res.body.meta.pagination).toHaveProperty("total", 1);
    });

    it("supports report_type filter", async () => {
      mockAuth("manager");
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
      (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      await request(app).get("/api/reports?report_type=audit_export").set("Cookie", "westbridge_sid=valid-token");

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ resource: "audit_export" }),
        }),
      );
    });

    it("returns 403 for viewer role", async () => {
      mockAuth("viewer");

      const res = await request(app).get("/api/reports").set("Cookie", "westbridge_sid=valid-token");

      expect(res.status).toBe(403);
    });
  });

  // ── GET /api/reports/:jobId ─────────────────────────────────────────────
  describe("GET /api/reports/:jobId", () => {
    it("returns completed job from BullMQ", async () => {
      mockAuth("manager");
      (reportsQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "job-1",
        data: { accountId: "acct-1", reportType: "revenue_summary" },
        getState: vi.fn().mockResolvedValue("completed"),
        returnvalue: { reportType: "revenue_summary", invoicesCreated: 5 },
      });

      const res = await request(app).get("/api/reports/job-1").set("Cookie", "westbridge_sid=valid-token");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("completed");
      expect(res.body.data.data).toHaveProperty("invoicesCreated", 5);
    });

    it("returns active/waiting job status from BullMQ", async () => {
      mockAuth("manager");
      (reportsQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "job-2",
        data: { accountId: "acct-1", reportType: "audit_export" },
        getState: vi.fn().mockResolvedValue("active"),
      });

      const res = await request(app).get("/api/reports/job-2").set("Cookie", "westbridge_sid=valid-token");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("active");
    });

    it("returns failed job with error reason", async () => {
      mockAuth("manager");
      (reportsQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "job-3",
        data: { accountId: "acct-1", reportType: "revenue_summary" },
        getState: vi.fn().mockResolvedValue("failed"),
        failedReason: "Database connection lost",
      });

      const res = await request(app).get("/api/reports/job-3").set("Cookie", "westbridge_sid=valid-token");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("failed");
      expect(res.body.data.error).toBe("Database connection lost");
    });

    it("falls back to audit log when job is not in BullMQ", async () => {
      mockAuth("manager");
      (reportsQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      (prisma.auditLog.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        resource: "user_activity",
        metadata: { userCount: 3, activeSessionCount: 1 },
        timestamp: new Date("2026-03-10"),
        userId: "user-1",
      });

      const res = await request(app).get("/api/reports/old-job-1").set("Cookie", "westbridge_sid=valid-token");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("completed");
      expect(res.body.data.reportType).toBe("user_activity");
    });

    it("returns 404 when job not found anywhere", async () => {
      mockAuth("manager");
      (reportsQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      (prisma.auditLog.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const res = await request(app).get("/api/reports/nonexistent").set("Cookie", "westbridge_sid=valid-token");

      expect(res.status).toBe(404);
    });

    it("returns 404 when job belongs to different account", async () => {
      mockAuth("manager");
      (reportsQueue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "job-other",
        data: { accountId: "other-account", reportType: "revenue_summary" },
        getState: vi.fn().mockResolvedValue("completed"),
        returnvalue: {},
      });

      const res = await request(app).get("/api/reports/job-other").set("Cookie", "westbridge_sid=valid-token");

      expect(res.status).toBe(404);
    });
  });
});
