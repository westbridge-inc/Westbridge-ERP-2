/**
 * /api/cortex/* route tests — auth, CSRF, validation, end-to-end with a
 * fake agent run.
 *
 * The Anthropic SDK is mocked at module level so the route never makes a
 * real API call. The Cortex engine is exercised end-to-end through the
 * route — we mock the dependencies that talk to external systems
 * (Anthropic, ERPNext via the ERP tools) and let the route + engine wire
 * the rest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ── External boundary mocks ──

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    account: { findUnique: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ name: "Test User" }) },
    auditLog: { create: vi.fn() },
    cortexConversation: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    cortexExecutionLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    cortexApprovalRequest: {
      create: vi.fn().mockResolvedValue({ id: "approval_1" }),
    },
    cortexEvent: {
      create: vi.fn().mockResolvedValue({ id: "event_1" }),
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

vi.mock("../../lib/ai/limits.js", () => ({
  checkAiLimit: vi.fn().mockResolvedValue({
    allowed: true,
    usage: { queries: 0, tokens: 0 },
    remaining: { queries: 100, tokens: 100_000 },
  }),
  recordAiUsage: vi.fn().mockResolvedValue(undefined),
  getAiUsage: vi.fn().mockResolvedValue({ queries: 0, tokens: 0 }),
}));

// Mock the Anthropic client export so the route's `if (!anthropic)` short-
// circuit and the engine both see a deterministic fake.
const fakeMessagesCreate = vi.fn();
vi.mock("../../lib/ai/claude.js", () => ({
  anthropic: {
    messages: {
      create: (...args: unknown[]) => fakeMessagesCreate(...args),
    },
  },
  AI_MODELS: { chat: "claude-sonnet-4-6", analysis: "claude-opus-4-6" },
  hasUnlimitedAi: vi.fn().mockReturnValue(false),
  isAiConfigured: vi.fn().mockReturnValue(true),
}));

// Block the ERP tool handlers from hitting ERPNext during end-to-end tests.
vi.mock("../../lib/ai/tools.js", () => ({
  ERP_TOOLS: [
    {
      name: "list_records",
      description: "List records",
      input_schema: { type: "object", properties: {}, required: [] },
    },
  ],
  executeTool: vi.fn().mockResolvedValue("[]"),
}));

vi.mock("../../lib/jobs/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/jobs/queue.js")>();
  return {
    ...actual,
    cortexQueue: { add: vi.fn().mockResolvedValue({}) },
    emailQueue: { add: vi.fn(), getWaitingCount: vi.fn().mockResolvedValue(0) },
    reportsQueue: { add: vi.fn(), getWaitingCount: vi.fn().mockResolvedValue(0) },
    cleanupQueue: { add: vi.fn() },
    webhooksQueue: { add: vi.fn() },
  };
});

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

vi.mock("../../lib/metering.js", () => ({
  meter: {
    increment: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      api_calls: 0,
      erp_docs_created: 0,
      ai_tokens_input: 0,
      ai_tokens_output: 0,
      active_users_count: 0,
      period: "2026-04",
    }),
    recordActiveUser: vi.fn().mockResolvedValue(undefined),
  },
  estimateAiCost: vi.fn().mockReturnValue(0),
}));

vi.mock("../../lib/analytics/posthog.server.js", () => ({
  identify: vi.fn(),
  capture: vi.fn(),
}));

// ── Imports AFTER mocks ──

import { createApp } from "../../app.js";
import { validateSession } from "../../lib/services/session.service.js";
import { prisma } from "../../lib/data/prisma.js";

const app = createApp();
const SESSION_COOKIE = "westbridge_sid=test-session-token";
const CSRF_COOKIE = "westbridge_csrf=test-csrf-token";

function mockSession(role = "owner") {
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

function mockAccount() {
  (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    plan: "enterprise",
    companyName: "Test Co",
    erpnextCompany: "Test Co",
  });
}

function mockNewConversation() {
  (prisma.cortexConversation.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "conv_new",
    accountId: "acc_1",
    userId: "usr_1",
    title: "Hello",
    messages: [],
    lastAgentId: "conversation",
    archived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function fakeTextResponse(text: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-6",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  };
}

describe("POST /api/cortex/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNewConversation();
    fakeMessagesCreate.mockResolvedValue(fakeTextResponse("Hello there."));
  });

  it("returns 401 without authentication", async () => {
    const res = await request(app).post("/api/cortex/chat").send({ message: "hi" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when message is missing or empty", async () => {
    mockSession();
    mockAccount();

    const res = await request(app)
      .post("/api/cortex/chat")
      .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
      .set("x-csrf-token", "test-csrf-token")
      .send({ message: "" });

    expect(res.status).toBe(400);
  });

  it("streams a successful chat reply via SSE", async () => {
    mockSession();
    mockAccount();

    const res = await request(app)
      .post("/api/cortex/chat")
      .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
      .set("x-csrf-token", "test-csrf-token")
      .send({ message: "say hello" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    // Body is the raw SSE stream — assert we got the start, delta, and done frames.
    expect(res.text).toContain("event: start");
    expect(res.text).toContain("event: delta");
    expect(res.text).toContain("event: done");
    expect(res.text).toContain("Hello there.");
    expect(res.text).toContain('"agentId":"conversation"');
  });

  it("returns 402 when AI usage limit is reached", async () => {
    mockSession();
    mockAccount();
    const { checkAiLimit } = await import("../../lib/ai/limits.js");
    (checkAiLimit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      allowed: false,
      reason: "Monthly query limit reached",
      usage: { queries: 999, tokens: 0 },
      remaining: { queries: 0, tokens: 0 },
    });

    const res = await request(app)
      .post("/api/cortex/chat")
      .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
      .set("x-csrf-token", "test-csrf-token")
      .send({ message: "hi" });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("AI_LIMIT_REACHED");
  });

  it("returns 404 when account is missing", async () => {
    mockSession();
    (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/cortex/chat")
      .set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`)
      .set("x-csrf-token", "test-csrf-token")
      .send({ message: "hi" });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/cortex/conversations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without authentication", async () => {
    const res = await request(app).get("/api/cortex/conversations");
    expect(res.status).toBe(401);
  });

  it("returns the user's conversations when authenticated", async () => {
    mockSession();
    (prisma.cortexConversation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "conv_1",
        title: "About invoices",
        lastAgentId: "conversation",
        lastTraceId: "trace_1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await request(app).get("/api/cortex/conversations").set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`);

    expect(res.status).toBe(200);
    expect(res.body.data.conversations).toHaveLength(1);
    expect(res.body.data.conversations[0].title).toBe("About invoices");
  });
});

describe("GET /api/cortex/activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without authentication", async () => {
    const res = await request(app).get("/api/cortex/activity");
    expect(res.status).toBe(401);
  });

  it("returns recent execution log entries", async () => {
    mockSession();
    (prisma.cortexExecutionLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "log_1",
        agentId: "conversation",
        traceId: "trace_1",
        status: "success",
        model: "claude-opus-4-6",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
        latencyMs: 1500,
        iterations: 1,
        toolCallCount: 0,
        toolCallErrors: 0,
        createdAt: new Date(),
      },
    ]);

    const res = await request(app).get("/api/cortex/activity").set("Cookie", `${SESSION_COOKIE}; ${CSRF_COOKIE}`);

    expect(res.status).toBe(200);
    expect(res.body.data.activity).toHaveLength(1);
    expect(res.body.data.activity[0].agentId).toBe("conversation");
  });
});
