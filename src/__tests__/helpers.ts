/**
 * Shared test helpers and utilities.
 *
 * For route tests (supertest), vi.mock() must be in the test file itself
 * because vitest only hoists vi.mock() calls from the test file.
 * Use setupRouteTest.ts as a vitest setup file instead.
 *
 * This file provides non-mock helpers: session setup, cookies, etc.
 */
import { vi } from "vitest";

// ── Session helper ──────────────────────────────────────────────────────────

/**
 * Configure mocked validateSession to return a valid session.
 */
export function mockValidSession(
  validateSession: ReturnType<typeof vi.fn>,
  overrides: { userId?: string; accountId?: string; role?: string; erpnextSid?: string } = {},
) {
  validateSession.mockResolvedValue({
    ok: true,
    data: {
      userId: overrides.userId ?? "usr_1",
      accountId: overrides.accountId ?? "acc_1",
      role: overrides.role ?? "owner",
      erpnextSid: overrides.erpnextSid ?? "erp-sid-123",
    },
  });
}

/** Standard cookies for supertest route tests. */
export const SESSION_COOKIE = "westbridge_sid=test-session-token";
export const CSRF_COOKIE = "westbridge_csrf=test-csrf-token";

/**
 * Shared Prisma mock factory. Returns an object suitable for vi.mock return value.
 * Each test file should still call vi.mock() in their own file scope,
 * but can call this to get the standard mock shape.
 */
export function createPrismaMock(overrides: Record<string, unknown> = {}) {
  return {
    prisma: {
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      $executeRaw: vi.fn().mockResolvedValue(0),
      $transaction: vi.fn().mockImplementation((fn: unknown) =>
        typeof fn === "function"
          ? fn({
              account: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
              user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
            })
          : Promise.resolve([]),
      ),
      account: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      user: { findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
      session: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      auditLog: { create: vi.fn() },
      inviteToken: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        delete: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      subscription: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      billingInvoice: { create: vi.fn(), updateMany: vi.fn() },
      webhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      ssoConfig: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      totpSecret: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      ...overrides,
    },
  };
}

/**
 * Standard BullMQ queue mock factory.
 */
export function createQueueMock() {
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
}

/**
 * Standard metering mock factory.
 */
export function createMeteringMock() {
  return {
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
  };
}
