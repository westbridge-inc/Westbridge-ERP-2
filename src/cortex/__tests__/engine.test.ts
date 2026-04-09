/**
 * Cortex engine tests — agentic loop, autonomy gating, financial limit gating,
 * cost calculation, tool error handling, iteration cap.
 *
 * The Anthropic client is faked: every test pre-programs a sequence of
 * `messages.create` responses that the engine consumes one per iteration.
 * This lets us test the loop logic deterministically without hitting the
 * real API.
 */

import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { executeAgent, __testing__ } from "../engine.js";
import { AUTONOMY, type CortexAgentDefinition, type CortexToolContext, type UsageGate } from "../protocol.js";

// ─── Test fixtures ─────────────────────────────────────────────────────────

/** Build a fake Anthropic client whose `messages.create` returns pre-programmed responses one at a time. */
function fakeClient(responses: Anthropic.Message[]): Anthropic {
  let i = 0;
  const create = vi.fn().mockImplementation(() => {
    if (i >= responses.length) throw new Error(`fakeClient: out of pre-programmed responses (asked for #${i + 1})`);
    return Promise.resolve(responses[i++]);
  });
  return { messages: { create } } as unknown as Anthropic;
}

function textOnlyMessage(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-6",
    content: [{ type: "text", text, citations: null }] as Anthropic.ContentBlock[],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}

function toolUseMessage(toolName: string, input: Record<string, unknown>, toolUseId = "tu_1"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-6",
    content: [{ type: "tool_use", id: toolUseId, name: toolName, input }] as Anthropic.ContentBlock[],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 200,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}

function ctx(overrides: Partial<CortexToolContext> = {}): CortexToolContext {
  return {
    accountId: "acc_test",
    userId: "usr_test",
    agentId: "test-agent",
    traceId: "trace_test",
    autonomyLevel: AUTONOMY.AUTONOMOUS,
    erpnextCompany: "Test Co",
    erpnextSid: null,
    // Cast to any so we don't have to instantiate a real Prisma client in tests
    prisma: {} as unknown as CortexToolContext["prisma"],
    ...overrides,
  };
}

function buildAgent(overrides: Partial<CortexAgentDefinition> = {}): CortexAgentDefinition {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "Test",
    model: "claude-opus-4-6",
    systemPrompt: "You are a test agent.",
    maxTokens: 4_096,
    adaptiveThinking: false,
    tools: [],
    autonomyLevel: AUTONOMY.AUTONOMOUS,
    maxFinancialImpactUsd: 10_000,
    maxIterations: 5,
    timeoutMs: 30_000,
    dailyTokenBudget: 100_000,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("engine.executeAgent — happy paths", () => {
  it("returns success when the model replies with text only", async () => {
    const client = fakeClient([textOnlyMessage("Hello, how can I help?")]);
    const agent = buildAgent();
    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "hi" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("success");
    expect(result.output).toBe("Hello, how can I help?");
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toEqual([]);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("runs the agentic loop when the model uses a tool, then returns text", async () => {
    const handler = vi.fn().mockResolvedValue({ records: [{ id: "INV-001", total: 500 }] });
    const agent = buildAgent({
      tools: [
        {
          name: "list_invoices",
          description: "List invoices",
          inputSchema: { type: "object" },
          handler,
          sideEffects: false,
          requiresApproval: false,
          reversible: true,
          maxCallsPerRun: 5,
        },
      ],
    });
    const client = fakeClient([
      toolUseMessage("list_invoices", { limit: 10 }),
      textOnlyMessage("Found 1 invoice for $500."),
    ]);

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "show invoices" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("success");
    expect(result.output).toBe("Found 1 invoice for $500.");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ tool: "list_invoices", success: true });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("engine.executeAgent — safety gates", () => {
  it("halts with needs_approval when a tool requires approval below autonomous", async () => {
    const handler = vi.fn();
    const agent = buildAgent({
      tools: [
        {
          name: "delete_record",
          description: "Delete",
          inputSchema: { type: "object" },
          handler,
          sideEffects: true,
          requiresApproval: true,
          reversible: false,
          maxCallsPerRun: 1,
        },
      ],
    });
    const client = fakeClient([toolUseMessage("delete_record", { id: "INV-001" })]);

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "delete invoice" }],
      ctx: ctx({ autonomyLevel: AUTONOMY.SUPERVISED }), // 2 < 3
    });

    expect(result.status).toBe("needs_approval");
    expect(handler).not.toHaveBeenCalled();
    expect(result.pendingAction).toBeDefined();
    expect(result.pendingAction?.toolName).toBe("delete_record");
    expect(result.pendingAction?.reason).toContain("approval");
  });

  it("halts with needs_approval when financial impact exceeds the agent limit", async () => {
    const handler = vi.fn();
    const agent = buildAgent({
      maxFinancialImpactUsd: 1_000,
      tools: [
        {
          name: "issue_payment",
          description: "Issue payment",
          inputSchema: { type: "object" },
          handler,
          sideEffects: true,
          requiresApproval: false,
          reversible: false,
          maxCallsPerRun: 1,
        },
      ],
    });
    const client = fakeClient([toolUseMessage("issue_payment", { amount: 5_000 })]);

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "pay them" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("needs_approval");
    expect(handler).not.toHaveBeenCalled();
    expect(result.pendingAction?.reason).toMatch(/exceeds agent limit/);
  });

  it("permits the call when financial impact is below the agent limit", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const agent = buildAgent({
      maxFinancialImpactUsd: 10_000,
      tools: [
        {
          name: "issue_payment",
          description: "Issue payment",
          inputSchema: { type: "object" },
          handler,
          sideEffects: true,
          requiresApproval: false,
          reversible: false,
          maxCallsPerRun: 1,
        },
      ],
    });
    const client = fakeClient([toolUseMessage("issue_payment", { amount: 500 }), textOnlyMessage("Payment issued.")]);

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "pay them $500" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("success");
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("engine.executeAgent — error handling", () => {
  it("captures a tool error as a failed tool call and lets the model continue", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("ERPNext is down"));
    const agent = buildAgent({
      tools: [
        {
          name: "list_invoices",
          description: "List invoices",
          inputSchema: { type: "object" },
          handler,
          sideEffects: false,
          requiresApproval: false,
          reversible: true,
          maxCallsPerRun: 5,
        },
      ],
    });
    const client = fakeClient([
      toolUseMessage("list_invoices", {}),
      textOnlyMessage("I couldn't fetch invoices — please try again."),
    ]);

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "show invoices" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("success");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ success: false, error: "ERPNext is down" });
    expect(result.output).toContain("couldn't fetch");
  });

  it("rejects an unknown tool name and lets the model recover", async () => {
    const agent = buildAgent({ tools: [] });
    const client = fakeClient([
      toolUseMessage("unknown_tool", {}),
      textOnlyMessage("I don't have that tool available."),
    ]);

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "use unknown" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("success");
    expect(result.toolCalls[0]).toMatchObject({ success: false, error: "unknown tool" });
  });

  it("returns failed when the API call throws", async () => {
    const create = vi.fn().mockRejectedValue(new Error("503 service unavailable"));
    const client = { messages: { create } } as unknown as Anthropic;
    const agent = buildAgent();

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "hi" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("503");
  });

  it("returns failed when client is null (graceful degradation)", async () => {
    const result = await executeAgent({
      client: null,
      agent: buildAgent(),
      messages: [{ role: "user", content: "hi" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe("engine.executeAgent — iteration cap + tool call cap", () => {
  it("hits the iteration cap when the model loops forever", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const agent = buildAgent({
      maxIterations: 3,
      tools: [
        {
          name: "loop_tool",
          description: "Loop",
          inputSchema: { type: "object" },
          handler,
          sideEffects: false,
          requiresApproval: false,
          reversible: true,
          maxCallsPerRun: 100,
        },
      ],
    });
    // Pre-program 3 tool_use responses; the 4th would be a text reply but
    // we never get there because the cap is 3.
    const client = fakeClient([
      toolUseMessage("loop_tool", {}, "tu_1"),
      toolUseMessage("loop_tool", {}, "tu_2"),
      toolUseMessage("loop_tool", {}, "tu_3"),
    ]);

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "loop" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("failed");
    expect(result.iterations).toBe(3);
    expect(result.errorMessage).toMatch(/iteration cap/);
  });

  it("rejects a per-run tool call cap and lets the model recover", async () => {
    let callCount = 0;
    const handler = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({ count: callCount });
    });
    const agent = buildAgent({
      tools: [
        {
          name: "limited_tool",
          description: "Limited",
          inputSchema: { type: "object" },
          handler,
          sideEffects: false,
          requiresApproval: false,
          reversible: true,
          maxCallsPerRun: 1,
        },
      ],
    });
    const client = fakeClient([
      toolUseMessage("limited_tool", {}, "tu_1"),
      toolUseMessage("limited_tool", {}, "tu_2"), // should be rejected
      textOnlyMessage("Done."),
    ]);

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "use it twice" }],
      ctx: ctx(),
    });

    expect(result.status).toBe("success");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.success).toBe(true);
    expect(result.toolCalls[1]?.success).toBe(false);
    expect(result.toolCalls[1]?.error).toMatch(/cap exceeded/);
  });
});

describe("engine.__testing__ — cost + impact helpers", () => {
  it("computes opus 4.6 cost from token counts", () => {
    // 1M input + 1M output @ $5 + $25
    expect(__testing__.costFor("claude-opus-4-6", 1_000_000, 1_000_000)).toBe(30);
    // 1K input only @ $5/1M = $0.005
    expect(__testing__.costFor("claude-opus-4-6", 1_000, 0)).toBeCloseTo(0.005, 6);
  });

  it("falls back to sonnet pricing for unknown models", () => {
    // Sonnet rates: $3 + $15
    const unknown = __testing__.costFor("claude-mystery", 1_000_000, 1_000_000);
    expect(unknown).toBe(18);
  });

  it("estimates financial impact from common amount fields", () => {
    expect(__testing__.estimateFinancialImpactUsd({ amount: 500 })).toBe(500);
    expect(__testing__.estimateFinancialImpactUsd({ total: 1234.56 })).toBe(1234.56);
    expect(__testing__.estimateFinancialImpactUsd({ grand_total: "9999" })).toBe(9999);
    expect(__testing__.estimateFinancialImpactUsd({ unrelated: "field" })).toBe(0);
    expect(__testing__.estimateFinancialImpactUsd(null)).toBe(0);
    expect(__testing__.estimateFinancialImpactUsd("not an object")).toBe(0);
  });
});

// ─── UsageGate ─────────────────────────────────────────────────────────────
//
// Phase 3 of the AI-Native overhaul: the engine accepts a usageGate that
// clamps autonomy, gates the run on plan quota, and records token usage
// per Claude API iteration. These tests use a fake gate so we can verify
// the engine wires it correctly without touching Redis or Prisma.

function fakeGate(overrides: Partial<UsageGate> = {}): UsageGate {
  return {
    clampAutonomy: vi.fn().mockResolvedValue(AUTONOMY.AUTONOMOUS),
    checkLimit: vi.fn().mockResolvedValue({ allowed: true }),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("engine.executeAgent — usage gate", () => {
  it("calls clampAutonomy + checkLimit before the first Claude call", async () => {
    const client = fakeClient([textOnlyMessage("hi")]);
    const agent = buildAgent();
    const gate = fakeGate();

    await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "ping" }],
      ctx: ctx(),
      usageGate: gate,
    });

    expect(gate.clampAutonomy).toHaveBeenCalledTimes(1);
    expect(gate.clampAutonomy).toHaveBeenCalledWith("acc_test", AUTONOMY.AUTONOMOUS);
    expect(gate.checkLimit).toHaveBeenCalledTimes(1);
    expect(gate.checkLimit).toHaveBeenCalledWith("acc_test");
  });

  it("returns failed (zero tokens charged) when checkLimit denies", async () => {
    const create = vi.fn();
    const client = { messages: { create } } as unknown as Anthropic;
    const agent = buildAgent();
    const gate = fakeGate({
      checkLimit: vi.fn().mockResolvedValue({ allowed: false, reason: "Monthly query limit reached" }),
    });

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "ping" }],
      ctx: ctx(),
      usageGate: gate,
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Monthly query limit reached");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    // Critical: Claude was NEVER called when the limit gate denied.
    expect(create).not.toHaveBeenCalled();
  });

  it("records usage after every iteration, not just at the end", async () => {
    // Two iterations: tool call → text reply.
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const agent = buildAgent({
      tools: [
        {
          name: "ping",
          description: "ping",
          inputSchema: { type: "object" },
          handler,
          sideEffects: false,
          requiresApproval: false,
          reversible: true,
          maxCallsPerRun: 5,
        },
      ],
    });
    const client = fakeClient([toolUseMessage("ping", {}), textOnlyMessage("done")]);
    const gate = fakeGate();

    await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "go" }],
      ctx: ctx(),
      usageGate: gate,
    });

    // recordUsage should fire ONCE per iteration — twice for this run.
    expect(gate.recordUsage).toHaveBeenCalledTimes(2);
    // Each call should pass the per-message token counts (200/50 from the
    // tool-use message and 100/50 from the text-only reply).
    expect(gate.recordUsage).toHaveBeenNthCalledWith(1, "acc_test", 200, 50);
    expect(gate.recordUsage).toHaveBeenNthCalledWith(2, "acc_test", 100, 50);
  });

  it("clamps autonomy to plan ceiling — Solo (L2) cannot run AUTONOMOUS tools", async () => {
    // Tool that requires approval — only AUTONOMOUS+ can execute it.
    const handler = vi.fn();
    const agent = buildAgent({
      tools: [
        {
          name: "make_payment",
          description: "Make a payment",
          inputSchema: { type: "object" },
          handler,
          sideEffects: true,
          requiresApproval: true,
          reversible: false,
          maxCallsPerRun: 1,
        },
      ],
    });
    // Agent definition asks for AUTONOMOUS, but the gate clamps to SUPERVISED.
    const client = fakeClient([toolUseMessage("make_payment", { amount: 100 })]);
    const gate = fakeGate({
      clampAutonomy: vi.fn().mockResolvedValue(AUTONOMY.SUPERVISED),
    });

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "pay vendor" }],
      ctx: ctx({ autonomyLevel: AUTONOMY.AUTONOMOUS }),
      usageGate: gate,
    });

    // The clamp pulled effective autonomy down to SUPERVISED, so the
    // approval-required tool gates out instead of executing.
    expect(result.status).toBe("needs_approval");
    expect(result.pendingAction?.toolName).toBe("make_payment");
    expect(handler).not.toHaveBeenCalled();
    // Verify the reason mentions the EFFECTIVE (clamped) autonomy, not requested.
    expect(result.pendingAction?.reason).toContain(`autonomy ${AUTONOMY.SUPERVISED}`);
  });

  it("fails closed if the gate itself throws (Redis down, DB hiccup)", async () => {
    const create = vi.fn();
    const client = { messages: { create } } as unknown as Anthropic;
    const agent = buildAgent();
    const gate = fakeGate({
      checkLimit: vi.fn().mockRejectedValue(new Error("redis is down")),
    });

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "ping" }],
      ctx: ctx(),
      usageGate: gate,
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("AI usage gate is unavailable");
    // Critical: Claude was NEVER called when the gate threw.
    expect(create).not.toHaveBeenCalled();
  });

  it("recordUsage failure is logged but does NOT fail the run (best-effort)", async () => {
    const client = fakeClient([textOnlyMessage("hello")]);
    const agent = buildAgent();
    const gate = fakeGate({
      recordUsage: vi.fn().mockRejectedValue(new Error("meter unreachable")),
    });

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "ping" }],
      ctx: ctx(),
      usageGate: gate,
    });

    // The user gets their reply even though the meter call failed.
    expect(result.status).toBe("success");
    expect(result.output).toBe("hello");
    expect(gate.recordUsage).toHaveBeenCalled();
  });

  it("legacy callers without a usageGate run unchanged", async () => {
    const client = fakeClient([textOnlyMessage("legacy")]);
    const agent = buildAgent();

    const result = await executeAgent({
      client,
      agent,
      messages: [{ role: "user", content: "ping" }],
      ctx: ctx(),
      // No usageGate — legacy fixtures must still pass.
    });

    expect(result.status).toBe("success");
    expect(result.output).toBe("legacy");
  });
});
