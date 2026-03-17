import { describe, it, expect, vi } from "vitest";

vi.mock("../../modules.js", () => ({
  getPlan: vi.fn((planId: string) => {
    if (planId === "enterprise") return { limits: { aiQueriesPerMonth: -1 } };
    if (planId === "business") return { limits: { aiQueriesPerMonth: 500 } };
    return { limits: { aiQueriesPerMonth: 50 } };
  }),
}));

vi.mock("@anthropic-ai/sdk", () => {
  return { default: vi.fn() };
});

import { hasUnlimitedAi, isAiConfigured } from "../claude.js";

describe("claude", () => {
  it("hasUnlimitedAi returns true for enterprise", () => {
    expect(hasUnlimitedAi("enterprise")).toBe(true);
  });

  it("hasUnlimitedAi returns false for starter", () => {
    expect(hasUnlimitedAi("starter")).toBe(false);
  });

  it("hasUnlimitedAi returns false for business", () => {
    expect(hasUnlimitedAi("business")).toBe(false);
  });

  it("isAiConfigured returns boolean", () => {
    // Without ANTHROPIC_API_KEY set, anthropic should be null
    expect(typeof isAiConfigured()).toBe("boolean");
  });
});
