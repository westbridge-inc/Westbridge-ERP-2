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

vi.mock("../../lib/data/prisma.js", () => ({
  prisma: {
    cortexEvent: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    cortexExecutionLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

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

import { processCortexEvent, registerEventHandler, lookupEventHandler, _resetDispatchForTests } from "../processor.js";
import { prisma } from "../../lib/data/prisma.js";

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
