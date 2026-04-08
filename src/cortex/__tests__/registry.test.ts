/**
 * Cortex registry tests — register, lookup, list, duplicate prevention.
 * The registry is a small in-memory map but the duplicate detection prevents
 * a real foot-gun (two files registering the same agent id silently
 * shadowing each other).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { registerAgent, getAgent, listAgents, getAgentTool, __resetRegistry__ } from "../registry.js";
import { AUTONOMY, type CortexAgentDefinition, type CortexToolDefinition } from "../protocol.js";

const dummyTool: CortexToolDefinition = {
  name: "dummy_tool",
  description: "Does nothing.",
  inputSchema: { type: "object" },
  handler: async () => null,
  sideEffects: false,
  requiresApproval: false,
  reversible: true,
  maxCallsPerRun: 1,
};

function buildAgent(id: string): CortexAgentDefinition {
  return {
    id,
    name: `Agent ${id}`,
    description: "Test",
    model: "claude-opus-4-6",
    systemPrompt: "Be helpful.",
    maxTokens: 1_000,
    adaptiveThinking: false,
    tools: [dummyTool],
    autonomyLevel: AUTONOMY.AUTONOMOUS,
    maxFinancialImpactUsd: 1_000,
    maxIterations: 5,
    timeoutMs: 10_000,
    dailyTokenBudget: 10_000,
  };
}

describe("registry", () => {
  beforeEach(() => {
    __resetRegistry__();
  });

  it("registers and retrieves an agent", () => {
    registerAgent(buildAgent("alpha"));
    const agent = getAgent("alpha");
    expect(agent).toBeDefined();
    expect(agent?.name).toBe("Agent alpha");
  });

  it("returns undefined for unknown agents", () => {
    expect(getAgent("nope")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    registerAgent(buildAgent("alpha"));
    expect(() => registerAgent(buildAgent("alpha"))).toThrow(/already registered/);
  });

  it("listAgents returns all registered agents", () => {
    registerAgent(buildAgent("alpha"));
    registerAgent(buildAgent("beta"));
    registerAgent(buildAgent("gamma"));
    const ids = listAgents()
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual(["alpha", "beta", "gamma"]);
  });

  it("getAgentTool finds a tool inside an agent", () => {
    registerAgent(buildAgent("alpha"));
    const tool = getAgentTool("alpha", "dummy_tool");
    expect(tool?.name).toBe("dummy_tool");
  });

  it("getAgentTool returns undefined for unknown tool name", () => {
    registerAgent(buildAgent("alpha"));
    expect(getAgentTool("alpha", "missing")).toBeUndefined();
  });

  it("getAgentTool returns undefined for unknown agent id", () => {
    expect(getAgentTool("nope", "dummy_tool")).toBeUndefined();
  });
});
