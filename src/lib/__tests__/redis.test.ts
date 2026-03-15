import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock before import
vi.mock("ioredis", () => {
  const RedisMock = vi.fn(() => ({
    quit: vi.fn().mockResolvedValue("OK"),
  }));
  const ClusterMock = vi.fn(() => ({
    quit: vi.fn().mockResolvedValue("OK"),
  }));
  return { Redis: RedisMock, Cluster: ClusterMock };
});

describe("redis", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_CLUSTER_NODES;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
  });

  describe("getRedisConfig", () => {
    it("parses REDIS_URL", async () => {
      process.env.REDIS_URL = "redis://myhost:6380";
      const { getRedisConfig } = await import("../redis.js");
      const config = getRedisConfig();
      expect(config.host).toBe("myhost");
      expect(config.port).toBe(6380);
    });

    it("uses defaults when no env vars", async () => {
      const { getRedisConfig } = await import("../redis.js");
      const config = getRedisConfig();
      expect(config.host).toBe("localhost");
      expect(config.port).toBe(6379);
    });

    it("parses password from REDIS_URL", async () => {
      process.env.REDIS_URL = "redis://:mypass@host:6379";
      const { getRedisConfig } = await import("../redis.js");
      const config = getRedisConfig();
      expect(config.password).toBe("mypass");
    });

    it("falls back to REDIS_HOST/PORT", async () => {
      process.env.REDIS_HOST = "custom-host";
      process.env.REDIS_PORT = "6381";
      const { getRedisConfig } = await import("../redis.js");
      const config = getRedisConfig();
      expect(config.host).toBe("custom-host");
      expect(config.port).toBe(6381);
    });
  });

  describe("getRedis", () => {
    it("returns a redis instance", async () => {
      const { getRedis } = await import("../redis.js");
      const redis = getRedis();
      expect(redis).not.toBeNull();
    });
  });

  describe("closeRedis", () => {
    it("closes redis connection", async () => {
      const { getRedis, closeRedis } = await import("../redis.js");
      getRedis(); // ensure connected
      await closeRedis();
      // Should not throw
    });
  });
});
