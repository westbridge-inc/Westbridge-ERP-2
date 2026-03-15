import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  scan: vi.fn(),
  mget: vi.fn(),
};

vi.mock("../redis.js", () => ({ getRedis: () => mockRedis }));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../realtime.js", () => ({ publish: vi.fn() }));
vi.mock("../flags.config.js", () => ({
  FLAGS_CONFIG: {
    test_flag: {
      key: "test_flag",
      defaultValue: false,
      rules: [],
    },
    env_flag: {
      key: "env_flag",
      defaultValue: false,
      rules: [{ condition: "environment", operator: "equals", value: "production", flagValue: true }],
    },
    user_flag: {
      key: "user_flag",
      defaultValue: false,
      rules: [{ condition: "user_id", operator: "equals", value: "user-123", flagValue: true }],
    },
  },
}));

import { getFlag, getAllFlags, setFlag } from "../feature-flags.js";

describe("feature-flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getFlag", () => {
    it("returns default value when no rules match", async () => {
      mockRedis.get.mockResolvedValue(null);
      const val = await getFlag("test_flag", {});
      expect(val).toBe(false);
    });

    it("returns false for unknown flag", async () => {
      mockRedis.get.mockResolvedValue(null);
      const val = await getFlag("nonexistent");
      expect(val).toBe(false);
    });

    it("matches environment rule", async () => {
      mockRedis.get.mockResolvedValue(null);
      const val = await getFlag("env_flag", { environment: "production" });
      expect(val).toBe(true);
    });

    it("does not match wrong environment", async () => {
      mockRedis.get.mockResolvedValue(null);
      const val = await getFlag("env_flag", { environment: "staging" });
      expect(val).toBe(false);
    });

    it("matches user_id rule", async () => {
      mockRedis.get.mockResolvedValue(null);
      const val = await getFlag("user_flag", { userId: "user-123" });
      expect(val).toBe(true);
    });

    it("uses stored flag over config", async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          key: "test_flag",
          defaultValue: true,
          rules: [],
        }),
      );
      const val = await getFlag("test_flag");
      expect(val).toBe(true);
    });
  });

  describe("getAllFlags", () => {
    it("returns config defaults when redis has no flags", async () => {
      mockRedis.scan.mockResolvedValue(["0", []]);
      const flags = await getAllFlags();
      expect(flags.length).toBeGreaterThan(0);
    });

    it("returns stored flags from redis when present", async () => {
      mockRedis.scan.mockResolvedValue(["0", ["flags:a"]]);
      mockRedis.mget.mockResolvedValue([JSON.stringify({ key: "a", defaultValue: true, rules: [] })]);
      const flags = await getAllFlags();
      expect(flags.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("setFlag", () => {
    it("stores flag in redis", async () => {
      mockRedis.set.mockResolvedValue("OK");
      await setFlag({ key: "test", defaultValue: true, description: "test flag", rules: [] });
      expect(mockRedis.set).toHaveBeenCalledWith("flags:test", expect.any(String));
    });
  });
});
