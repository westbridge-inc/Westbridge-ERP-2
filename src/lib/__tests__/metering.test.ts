import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedis = {
  hincrbyfloat: vi.fn().mockResolvedValue("1"),
  expire: vi.fn().mockResolvedValue(1),
  sadd: vi.fn().mockResolvedValue(1),
  hgetall: vi.fn().mockResolvedValue({}),
  scan: vi.fn().mockResolvedValue(["0", []]),
  sunionstore: vi.fn().mockResolvedValue(0),
  del: vi.fn().mockResolvedValue(1),
};

vi.mock("../redis.js", () => ({ getRedis: () => mockRedis }));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn() },
}));

import { meter, estimateAiCost } from "../metering.js";

describe("metering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("meter.increment", () => {
    it("increments a metric in redis", async () => {
      await meter.increment("acc1", "api_calls", 1);
      expect(mockRedis.hincrbyfloat).toHaveBeenCalled();
      expect(mockRedis.expire).toHaveBeenCalled();
    });

    it("uses default value of 1", async () => {
      await meter.increment("acc1", "api_calls");
      expect(mockRedis.hincrbyfloat).toHaveBeenCalledWith(expect.any(String), "api_calls", 1);
    });

    it("does not throw on redis error", async () => {
      mockRedis.hincrbyfloat.mockRejectedValueOnce(new Error("fail"));
      await expect(meter.increment("acc1", "api_calls")).resolves.toBeUndefined();
    });
  });

  describe("meter.recordActiveUser", () => {
    it("adds userId to redis set", async () => {
      await meter.recordActiveUser("acc1", "user1");
      expect(mockRedis.sadd).toHaveBeenCalled();
    });
  });

  describe("meter.get", () => {
    it("returns empty usage when no data", async () => {
      mockRedis.hgetall.mockResolvedValue({});
      mockRedis.scan.mockResolvedValue(["0", []]);
      const usage = await meter.get("acc1");
      expect(usage.api_calls).toBe(0);
      expect(usage.active_users_count).toBe(0);
    });

    it("parses stored values", async () => {
      mockRedis.hgetall.mockResolvedValue({ api_calls: "42", erp_docs_created: "5" });
      mockRedis.scan.mockResolvedValue(["0", []]);
      const usage = await meter.get("acc1");
      expect(usage.api_calls).toBe(42);
      expect(usage.erp_docs_created).toBe(5);
    });

    it("counts active users from sets", async () => {
      mockRedis.hgetall.mockResolvedValue({});
      mockRedis.scan.mockResolvedValue(["0", ["meter:acc1:2026-03:active_users:2026-03-15"]]);
      mockRedis.sunionstore.mockResolvedValue(3);
      const usage = await meter.get("acc1");
      expect(usage.active_users_count).toBe(3);
    });
  });

  describe("meter.getAll", () => {
    it("returns usage for multiple months", async () => {
      mockRedis.hgetall.mockResolvedValue({});
      mockRedis.scan.mockResolvedValue(["0", []]);
      const all = await meter.getAll("acc1", 3);
      expect(all).toHaveLength(3);
    });
  });

  describe("estimateAiCost", () => {
    it("calculates cost correctly", () => {
      const cost = estimateAiCost(1000, 1000);
      expect(cost).toBe(0.005 + 0.015);
    });

    it("returns 0 for 0 tokens", () => {
      expect(estimateAiCost(0, 0)).toBe(0);
    });
  });
});
