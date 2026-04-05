import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedis = {
  hget: vi.fn(),
  hincrby: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
};

vi.mock("../../redis.js", () => ({
  getRedis: vi.fn(() => mockRedis),
}));

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../data/prisma.js", () => ({
  prisma: {
    account: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("../../modules.js", () => ({
  getPlan: vi.fn((planId: string) => {
    if (planId === "enterprise") {
      return {
        name: "Enterprise",
        limits: { aiQueriesPerMonth: -1, aiTokensPerMonth: -1 },
        overageRates: { perExtraAiQuery: 0.05 },
      };
    }
    if (planId === "business") {
      return {
        name: "Business",
        limits: { aiQueriesPerMonth: 500, aiTokensPerMonth: 1000000 },
        overageRates: { perExtraAiQuery: 0.05 },
      };
    }
    return {
      name: "Starter",
      limits: { aiQueriesPerMonth: 50, aiTokensPerMonth: 100000 },
      overageRates: { perExtraAiQuery: 0.1 },
    };
  }),
}));

import { getAiUsage, checkAiLimit, recordAiUsage } from "../limits.js";

describe("AI limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getAiUsage", () => {
    it("returns usage from Redis", async () => {
      mockRedis.hget.mockResolvedValueOnce("10").mockResolvedValueOnce("5000");
      const usage = await getAiUsage("acc_1");
      expect(usage).toEqual({ queries: 10, tokens: 5000 });
    });

    it("returns zeros when Redis returns null", async () => {
      mockRedis.hget.mockResolvedValue(null);
      const usage = await getAiUsage("acc_1");
      expect(usage).toEqual({ queries: 0, tokens: 0 });
    });
  });

  describe("checkAiLimit", () => {
    it("allows enterprise with unlimited queries", async () => {
      mockRedis.hget.mockResolvedValue("0");
      const result = await checkAiLimit("acc_1", "enterprise");
      expect(result.allowed).toBe(true);
      expect(result.remaining.queries).toBeNull();
    });

    it("allows starter within limits", async () => {
      mockRedis.hget.mockResolvedValueOnce("5").mockResolvedValueOnce("1000");
      const result = await checkAiLimit("acc_1", "starter");
      expect(result.allowed).toBe(true);
      expect(result.remaining.queries).toBe(45);
    });

    it("denies when query limit exceeded", async () => {
      mockRedis.hget.mockResolvedValueOnce("50").mockResolvedValueOnce("1000");
      const result = await checkAiLimit("acc_1", "starter");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("limit reached");
    });

    it("denies when token limit exceeded", async () => {
      mockRedis.hget.mockResolvedValueOnce("10").mockResolvedValueOnce("100000");
      const result = await checkAiLimit("acc_1", "starter");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("token limit");
    });
  });

  describe("recordAiUsage", () => {
    it("increments query and token counts in Redis", async () => {
      await recordAiUsage("acc_1", 100, 200);
      expect(mockRedis.hincrby).toHaveBeenCalledWith(expect.any(String), "queries", 1);
      expect(mockRedis.hincrby).toHaveBeenCalledWith(expect.any(String), "tokens", 300);
      expect(mockRedis.expire).toHaveBeenCalled();
    });
  });
});
