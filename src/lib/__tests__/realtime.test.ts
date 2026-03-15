import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedis = {
  publish: vi.fn().mockResolvedValue(1),
  duplicate: vi.fn(() => ({
    on: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  })),
};

vi.mock("../redis.js", () => ({ getRedis: () => mockRedis }));
vi.mock("../logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { publish, subscribe, GLOBAL_CHANNEL } from "../realtime.js";

describe("realtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("publish", () => {
    it("publishes to account channel", async () => {
      await publish("acc1", { type: "test", payload: {}, timestamp: "now" });
      expect(mockRedis.publish).toHaveBeenCalledWith("realtime:acc1", expect.any(String));
    });

    it("publishes to global channel for '*'", async () => {
      await publish("*", { type: "test", payload: {}, timestamp: "now" });
      expect(mockRedis.publish).toHaveBeenCalledWith(GLOBAL_CHANNEL, expect.any(String));
    });

    it("does not throw on redis error", async () => {
      mockRedis.publish.mockRejectedValueOnce(new Error("fail"));
      await expect(publish("acc1", { type: "test", payload: {}, timestamp: "now" })).resolves.toBeUndefined();
    });
  });

  describe("subscribe", () => {
    it("returns an unsubscribe function", async () => {
      const unsub = await subscribe("acc1", () => {});
      expect(typeof unsub).toBe("function");
    });

    it("calls duplicate to create subscriber", async () => {
      await subscribe("acc1", () => {});
      expect(mockRedis.duplicate).toHaveBeenCalled();
    });
  });

  describe("GLOBAL_CHANNEL", () => {
    it("is prefixed with realtime:", () => {
      expect(GLOBAL_CHANNEL).toBe("realtime:*");
    });
  });
});
