/**
 * Rate limit tier tests — unit tests for pure functions and integration tests
 * for the Redis-backed sliding window algorithm.
 *
 * Unit tests (no Redis): getClientIdentifier, rateLimitHeaders, planToTier, getPlanRateLimit
 * Integration tests (Redis required): checkTieredRateLimit, checkEmailRateLimit, checkErpAccountRateLimit
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import {
  getClientIdentifier,
  rateLimitHeaders,
  planToTier,
  getPlanRateLimit,
  checkTieredRateLimit,
  checkEmailRateLimit,
  checkErpAccountRateLimit,
  type RateLimitResult,
} from "../rate-limit-tiers.js";

// ─── Unit Tests (pure functions, no Redis) ─────────────────────────────────

describe("getClientIdentifier", () => {
  function makeRequest(headers: Record<string, string>): Request {
    return {
      headers: new Headers(headers),
    } as unknown as Request;
  }

  it("extracts IP from x-forwarded-for (single IP)", () => {
    const req = makeRequest({ "x-forwarded-for": "203.0.113.50" });
    expect(getClientIdentifier(req)).toBe("203.0.113.50");
  });

  it("extracts first IP from x-forwarded-for (comma-separated proxy chain)", () => {
    const req = makeRequest({
      "x-forwarded-for": "203.0.113.50, 70.41.3.18, 150.172.238.178",
    });
    expect(getClientIdentifier(req)).toBe("203.0.113.50");
  });

  it("falls back to x-real-ip when x-forwarded-for is missing", () => {
    const req = makeRequest({ "x-real-ip": "198.51.100.14" });
    expect(getClientIdentifier(req)).toBe("198.51.100.14");
  });

  it("returns 'anonymous' when no IP headers are present", () => {
    const req = makeRequest({});
    expect(getClientIdentifier(req)).toBe("anonymous");
  });

  it("trims whitespace from x-forwarded-for IP", () => {
    const req = makeRequest({ "x-forwarded-for": "  203.0.113.50  , 70.41.3.18" });
    expect(getClientIdentifier(req)).toBe("203.0.113.50");
  });
});

describe("rateLimitHeaders", () => {
  it("returns standard rate limit headers when allowed", () => {
    const result: RateLimitResult = {
      allowed: true,
      limit: 100,
      remaining: 95,
      reset: 1700000000,
    };
    const headers = rateLimitHeaders(result);
    expect(headers["X-RateLimit-Limit"]).toBe("100");
    expect(headers["X-RateLimit-Remaining"]).toBe("95");
    expect(headers["X-RateLimit-Reset"]).toBe("1700000000");
    expect(headers["Retry-After"]).toBeUndefined();
    expect(headers["X-RateLimit-Plan"]).toBeUndefined();
  });

  it("includes Retry-After header when request is rate-limited", () => {
    const result: RateLimitResult = {
      allowed: false,
      limit: 20,
      remaining: 0,
      reset: 1700000060,
      retryAfter: 60,
    };
    const headers = rateLimitHeaders(result);
    expect(headers["Retry-After"]).toBe("60");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
  });

  it("includes plan header when plan is specified", () => {
    const result: RateLimitResult = {
      allowed: true,
      limit: 200,
      remaining: 199,
      reset: 1700000000,
    };
    const headers = rateLimitHeaders(result, "business");
    expect(headers["X-RateLimit-Plan"]).toBe("business");
  });
});

describe("planToTier", () => {
  it("maps business plan to api_key tier", () => {
    expect(planToTier("business")).toBe("api_key");
  });

  it("maps enterprise plan to api_key tier", () => {
    expect(planToTier("enterprise")).toBe("api_key");
  });

  it("maps growth plan to authenticated tier", () => {
    expect(planToTier("growth")).toBe("authenticated");
  });

  it("maps professional plan to authenticated tier", () => {
    expect(planToTier("professional")).toBe("authenticated");
  });

  it("maps starter plan to authenticated tier", () => {
    expect(planToTier("starter")).toBe("authenticated");
  });

  it("defaults to authenticated for unknown plans", () => {
    expect(planToTier("unknown-plan")).toBe("authenticated");
  });

  it("defaults to authenticated for null/undefined", () => {
    expect(planToTier(null)).toBe("authenticated");
    expect(planToTier(undefined)).toBe("authenticated");
  });

  it("is case-insensitive", () => {
    expect(planToTier("BUSINESS")).toBe("api_key");
    expect(planToTier("Enterprise")).toBe("api_key");
    expect(planToTier("Growth")).toBe("authenticated");
  });
});

describe("getPlanRateLimit", () => {
  it("returns correct limit for starter plan with default operation", () => {
    const result = getPlanRateLimit("starter");
    expect(result.limit).toBe(60); // 60 requests / cost 1
    expect(result.windowMs).toBe(60_000);
  });

  it("returns correct limit for business plan with default operation", () => {
    const result = getPlanRateLimit("business");
    expect(result.limit).toBe(200);
    expect(result.windowMs).toBe(60_000);
  });

  it("returns correct limit for enterprise plan with default operation", () => {
    const result = getPlanRateLimit("enterprise");
    expect(result.limit).toBe(1000);
    expect(result.windowMs).toBe(60_000);
  });

  it("applies cost multiplier for erp_list operation", () => {
    const result = getPlanRateLimit("business", "erp_list");
    expect(result.limit).toBe(Math.floor(200 / 5)); // 200 / cost 5 = 40
    expect(result.windowMs).toBe(60_000);
  });

  it("applies cost multiplier for ai_chat operation", () => {
    const result = getPlanRateLimit("enterprise", "ai_chat");
    expect(result.limit).toBe(Math.floor(1000 / 10)); // 1000 / cost 10 = 100
    expect(result.windowMs).toBe(60_000);
  });

  it("uses default cost for unknown operations", () => {
    const result = getPlanRateLimit("starter", "unknown_op");
    expect(result.limit).toBe(60); // 60 / cost 1
  });

  it("falls back to starter tier for unknown plans", () => {
    const result = getPlanRateLimit("nonexistent");
    expect(result.limit).toBe(60);
    expect(result.windowMs).toBe(60_000);
  });
});

// ─── Integration Tests (require Redis) ──────────────────────────────────────
//
// These tests exercise the actual sliding window algorithm against a real
// Redis instance. They are skipped when REDIS_URL is not set (i.e. local dev).
// In CI, the integration-test job provides a Redis service container.

const REDIS_AVAILABLE = !!process.env.REDIS_URL;

describe.skipIf(!REDIS_AVAILABLE)("checkTieredRateLimit (Redis integration)", () => {
  const testIdentifier = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  afterAll(async () => {
    // Clean up test keys
    const { getRedis, closeRedis } = await import("../../redis.js");
    const redis = getRedis();
    if (redis) {
      const keys = await redis.keys(`rl2:*:${testIdentifier}*`);
      if (keys.length > 0) await redis.del(...keys);
    }
    await closeRedis();
  });

  it("allows first request within limit", async () => {
    const result = await checkTieredRateLimit(testIdentifier, "anonymous");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
    expect(result.limit).toBe(20);
  });

  it("enforces anonymous tier limit (20 req/min)", async () => {
    const id = `anon-flood-${Date.now()}`;
    // Fire 20 requests to fill the limit
    for (let i = 0; i < 20; i++) {
      await checkTieredRateLimit(id, "anonymous");
    }
    // 21st should be denied
    const result = await checkTieredRateLimit(id, "anonymous");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeDefined();

    // Clean up
    const { getRedis } = await import("../../redis.js");
    const redis = getRedis();
    if (redis) await redis.del(`rl2:anonymous:${id}`);
  });

  it("uses endpoint override limit when specified", async () => {
    const id = `login-${Date.now()}`;
    // /api/auth/login has limit of 10
    for (let i = 0; i < 10; i++) {
      await checkTieredRateLimit(id, "anonymous", "/api/auth/login");
    }
    const result = await checkTieredRateLimit(id, "anonymous", "/api/auth/login");
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(10);

    const { getRedis } = await import("../../redis.js");
    const redis = getRedis();
    if (redis) await redis.del(`rl2:anonymous:${id}`);
  });

  it("allows higher limits for authenticated tier", async () => {
    const id = `auth-${Date.now()}`;
    // Authenticated tier allows 100 req/min — verify first request succeeds
    const result = await checkTieredRateLimit(id, "authenticated");
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(99);

    const { getRedis } = await import("../../redis.js");
    const redis = getRedis();
    if (redis) await redis.del(`rl2:authenticated:${id}`);
  });
});

describe.skipIf(!REDIS_AVAILABLE)("checkEmailRateLimit (Redis integration)", () => {
  it("allows initial email requests", async () => {
    const email = `test-${Date.now()}@example.com`;
    const result = await checkEmailRateLimit(email);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.remaining).toBe(4);

    const { getRedis } = await import("../../redis.js");
    const redis = getRedis();
    if (redis) await redis.del(`rl2:email:${email}`);
  });

  it("blocks after 5 email requests per minute", async () => {
    const email = `flood-${Date.now()}@example.com`;
    for (let i = 0; i < 5; i++) {
      await checkEmailRateLimit(email);
    }
    const result = await checkEmailRateLimit(email);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);

    const { getRedis } = await import("../../redis.js");
    const redis = getRedis();
    if (redis) await redis.del(`rl2:email:${email}`);
  });

  it("normalises email to lowercase before rate limiting", async () => {
    const base = `case-${Date.now()}@example.com`;
    const upper = base.toUpperCase();

    // Use upper case — should normalise to lowercase
    await checkEmailRateLimit(upper);
    const result = await checkEmailRateLimit(base);
    // Both should share the same key
    expect(result.remaining).toBe(3); // 5 - 2 = 3

    const { getRedis } = await import("../../redis.js");
    const redis = getRedis();
    if (redis) await redis.del(`rl2:email:${base}`);
  });
});

describe.skipIf(!REDIS_AVAILABLE)("checkErpAccountRateLimit (Redis integration)", () => {
  it("allows requests within ERP account limit", async () => {
    const accountId = `acct-${Date.now()}`;
    const result = await checkErpAccountRateLimit(accountId);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(200);
    expect(result.remaining).toBe(199);

    const { getRedis } = await import("../../redis.js");
    const redis = getRedis();
    if (redis) await redis.del(`rl2:erp:${accountId}`);
  });

  it("returns correct remaining count after multiple requests", async () => {
    const accountId = `acct-multi-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      await checkErpAccountRateLimit(accountId);
    }
    const result = await checkErpAccountRateLimit(accountId);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(194); // 200 - 6 = 194

    const { getRedis } = await import("../../redis.js");
    const redis = getRedis();
    if (redis) await redis.del(`rl2:erp:${accountId}`);
  });
});
