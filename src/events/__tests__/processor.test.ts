/**
 * Cortex event processor tests — verify the processor:
 *   1. Loads the event row by id
 *   2. Returns "missing" when the row is gone
 *   3. Returns "already_processed" when processed=true
 *   4. Returns "no_handler" + marks processed when no agent is registered
 *   5. Dispatches to a registered agent + marks processed
 *   6. Never throws (poison-pill safety)
 *   7. Catches markProcessed failures so the worker keeps draining
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The processor now wraps its mark-processed + execution-log writes in
// `withTenantScope`, which delegates to `prisma.$transaction(fn)`. Each
// callback is invoked with a transaction client that mirrors the same
// model methods. We make `$transaction(fn)` simply pass `prismaMock`
// itself as the `tx` argument so the existing toHaveBeenCalledWith
// assertions on `prisma.cortexEvent.update` keep working.
vi.mock("../../lib/data/prisma.js", () => {
  const prismaMock: Record<string, unknown> = {
    cortexEvent: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    cortexExecutionLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    // withTenantScope calls $executeRaw to set the session variable, then
    // hands the tx client to the callback. The mock `tx` is the same
    // prismaMock object so the existing assertions still pass through.
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock)),
  };
  return { prisma: prismaMock };
});

vi.mock("../../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// vi.mock factories run BEFORE module-level variable declarations, so we
// use vi.hoisted() for any state that the mock factories need to share with
// the test bodies. The hoisted values are evaluated before the mocks.
const { registryMap, fakeExecuteAgent } = vi.hoisted(() => {
  return {
    registryMap: new Map<string, unknown>(),
    fakeExecuteAgent: vi.fn(),
  };
});

vi.mock("../../cortex/registry.js", () => ({
  getAgent: vi.fn((id: string) => registryMap.get(id)),
  registerAgent: vi.fn(),
  __resetRegistry__: vi.fn(() => registryMap.clear()),
}));

vi.mock("../../cortex/engine.js", () => ({
  executeAgent: fakeExecuteAgent,
}));

vi.mock("../../cortex/usage-gate.js", () => ({
  defaultUsageGate: {
    clampAutonomy: vi.fn().mockResolvedValue(3),
    checkLimit: vi.fn().mockResolvedValue({ allowed: true }),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../lib/ai/claude.js", () => ({
  // A non-null fake so the processor's `if (!anthropic)` short-circuit doesn't fire.
  anthropic: { messages: { create: vi.fn() } },
}));

// Tenant-mismatch defence (Phase 1 of the tenant isolation hardening) calls
// reportSecurityEvent. Mock it so we can assert it fires exactly once on
// mismatch and never on the happy path.
vi.mock("../../lib/security-monitor.js", () => ({
  reportSecurityEvent: vi.fn(),
}));

import { processCortexEvent, registerEventHandler, lookupEventHandler, _resetDispatchForTests } from "../processor.js";
import { prisma } from "../../lib/data/prisma.js";
import { reportSecurityEvent } from "../../lib/security-monitor.js";

/** Helper: register a fake agent in the mocked registry. */
function registerFakeAgent(id: string): void {
  registryMap.set(id, {
    id,
    name: `Fake ${id}`,
    autonomyLevel: 3,
    tools: [],
    model: "fake-model",
    systemPrompt: "fake",
    maxTokens: 100,
    adaptiveThinking: false,
    maxFinancialImpactUsd: 0,
    maxIterations: 1,
    timeoutMs: 1000,
    dailyTokenBudget: 100,
  });
}

const baseJob = {
  eventId: "evt_1",
  accountId: "acc_1",
  type: "sales_invoice.created",
  traceId: "trace_1",
};

function mockEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    accountId: "acc_1",
    eventType: "sales_invoice.created",
    source: "user.action",
    data: { invoiceId: "INV-001" },
    userId: "usr_1",
    agentId: null,
    traceId: "trace_1",
    processed: false,
    processedAt: null,
    processedBy: null,
    result: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("processor.processCortexEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetDispatchForTests();
    registryMap.clear();
    fakeExecuteAgent.mockResolvedValue({
      status: "success",
      output: "agent reply",
      traceId: "trace_1",
      agentId: "extract.invoice",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.0001,
      latencyMs: 50,
      iterations: 1,
      toolCalls: [],
    });
  });

  it("returns 'missing' when the event row is not found", async () => {
    (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await processCortexEvent(baseJob);

    expect(result.status).toBe("missing");
    expect(prisma.cortexEvent.update).not.toHaveBeenCalled();
  });

  it("returns 'already_processed' when processed=true (idempotency)", async () => {
    (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockEventRow({ processed: true, processedAt: new Date() }),
    );

    const result = await processCortexEvent(baseJob);

    expect(result.status).toBe("already_processed");
    // No second update — the row stays marked processed.
    expect(prisma.cortexEvent.update).not.toHaveBeenCalled();
  });

  it("returns 'no_handler' and marks processed when no agent is registered", async () => {
    (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockEventRow());
    (prisma.cortexEvent.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await processCortexEvent(baseJob);

    expect(result.status).toBe("no_handler");
    expect(prisma.cortexEvent.update).toHaveBeenCalledWith({
      where: { id: "evt_1" },
      data: expect.objectContaining({
        processed: true,
        processedBy: "no_handler",
        result: expect.objectContaining({ reason: expect.any(String) }),
      }),
    });
  });

  it("dispatches to the registered agent and marks processed", async () => {
    registerEventHandler("sales_invoice.created", "extract.invoice");
    registerFakeAgent("extract.invoice");
    (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockEventRow());
    (prisma.cortexEvent.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await processCortexEvent(baseJob);

    expect(result.status).toBe("processed");
    expect(result.agentId).toBe("extract.invoice");
    expect(fakeExecuteAgent).toHaveBeenCalled();
    expect(prisma.cortexEvent.update).toHaveBeenCalledWith({
      where: { id: "evt_1" },
      data: expect.objectContaining({
        processed: true,
        processedBy: "extract.invoice",
      }),
    });
  });

  it("returns no_handler when dispatch points at an agent not in the registry (deploy skew)", async () => {
    registerEventHandler("sales_invoice.created", "ghost.agent");
    // Deliberately do NOT register a fake agent for ghost.agent.
    (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockEventRow());
    (prisma.cortexEvent.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await processCortexEvent(baseJob);

    expect(result.status).toBe("no_handler");
    expect(fakeExecuteAgent).not.toHaveBeenCalled();
  });

  it("never throws when markProcessed fails (worker keeps draining)", async () => {
    registerEventHandler("sales_invoice.created", "extract.invoice");
    registerFakeAgent("extract.invoice");
    (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockEventRow());
    (prisma.cortexEvent.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB write timeout"));

    // Must not throw — the worker depends on this contract.
    const result = await processCortexEvent(baseJob);

    // Status reflects what we INTENDED (processed) even though the DB write
    // failed — BullMQ will redeliver and the second attempt will succeed.
    expect(result.status).toBe("processed");
  });

  it("captures executeAgent unexpected errors (catch-all safety)", async () => {
    registerEventHandler("sales_invoice.created", "extract.invoice");
    registerFakeAgent("extract.invoice");
    (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockEventRow());
    (prisma.cortexEvent.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    fakeExecuteAgent.mockRejectedValueOnce(new Error("engine crashed"));

    const result = await processCortexEvent(baseJob);

    expect(result.status).toBe("error");
    expect(result.error).toContain("engine crashed");
  });

  // -------------------------------------------------------------------------
  // Phase 1 — tenant isolation hardening: queue-poisoning defence.
  //
  // The job payload may carry an accountId that does not match the persisted
  // event row's accountId. This can happen via:
  //   - Compromised Redis credentials enqueuing forged jobs
  //   - Replay of an old job whose event id has been reused
  //   - Race against a recycled identifier
  //
  // The processor MUST refuse the dispatch, log + page the security team
  // via reportSecurityEvent, and leave the event row UNTOUCHED for a
  // legitimate retry. Tests below assert each of these properties.
  // -------------------------------------------------------------------------
  describe("tenant binding (Failure D fix)", () => {
    it("refuses to dispatch when job accountId does not match the row's accountId", async () => {
      registerEventHandler("sales_invoice.created", "extract.invoice");
      registerFakeAgent("extract.invoice");
      // Row belongs to acc_VICTIM
      (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEventRow({ accountId: "acc_VICTIM" }),
      );

      // Job claims acc_ATTACKER
      const result = await processCortexEvent({
        ...baseJob,
        accountId: "acc_ATTACKER",
      });

      expect(result.status).toBe("tenant_mismatch");
      // No agent dispatch happened.
      expect(fakeExecuteAgent).not.toHaveBeenCalled();
      // Row was NOT marked processed — leave it for a legitimate retry.
      expect(prisma.cortexEvent.update).not.toHaveBeenCalled();
      // Security event fired exactly once with the structured metadata
      // an on-call responder needs.
      expect(reportSecurityEvent).toHaveBeenCalledTimes(1);
      expect(reportSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "tenant_mismatch",
          accountId: "acc_ATTACKER",
          metadata: expect.objectContaining({
            eventId: "evt_1",
            jobAccountId: "acc_ATTACKER",
            rowAccountId: "acc_VICTIM",
          }),
        }),
      );
    });

    it("dispatches normally when accountIds match", async () => {
      registerEventHandler("sales_invoice.created", "extract.invoice");
      registerFakeAgent("extract.invoice");
      (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEventRow({ accountId: "acc_1" }),
      );
      (prisma.cortexEvent.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await processCortexEvent({ ...baseJob, accountId: "acc_1" });

      expect(result.status).toBe("processed");
      expect(reportSecurityEvent).not.toHaveBeenCalled();
      expect(fakeExecuteAgent).toHaveBeenCalled();
    });

    it("returns 'missing' (not 'tenant_mismatch') when the row does not exist", async () => {
      // Missing row is a separate failure path — must not raise a security
      // event because it can happen during a legitimate hard-delete race.
      (prisma.cortexEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await processCortexEvent({ ...baseJob, accountId: "acc_ATTACKER" });

      expect(result.status).toBe("missing");
      expect(reportSecurityEvent).not.toHaveBeenCalled();
    });
  });
});

describe("processor.registerEventHandler", () => {
  beforeEach(() => {
    _resetDispatchForTests();
  });

  it("registers a handler that lookupEventHandler can find", () => {
    registerEventHandler("invoice.created", "extract.invoice");
    expect(lookupEventHandler("invoice.created")).toBe("extract.invoice");
  });

  it("returns undefined for unregistered event types", () => {
    expect(lookupEventHandler("unknown.type")).toBeUndefined();
  });

  it("overwrites an existing registration (last writer wins)", () => {
    registerEventHandler("invoice.created", "agent_v1");
    registerEventHandler("invoice.created", "agent_v2");
    expect(lookupEventHandler("invoice.created")).toBe("agent_v2");
  });
});
