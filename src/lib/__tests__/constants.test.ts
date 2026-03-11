import { describe, it, expect } from "vitest";
import {
  HTTP,
  RATE_LIMIT,
  RATE_LIMIT_TIERS,
  RATE_LIMIT_COST,
  COOKIE,
  PAGINATION,
  LOCALE,
  CURRENCY_CODES,
  SECURITY,
} from "../constants.js";

describe("HTTP status codes", () => {
  it("defines standard status codes", () => {
    expect(HTTP.OK).toBe(200);
    expect(HTTP.BAD_REQUEST).toBe(400);
    expect(HTTP.UNAUTHORIZED).toBe(401);
    expect(HTTP.FORBIDDEN).toBe(403);
    expect(HTTP.NOT_FOUND).toBe(404);
    expect(HTTP.TOO_MANY_REQUESTS).toBe(429);
    expect(HTTP.SERVER_ERROR).toBe(500);
  });
});

describe("RATE_LIMIT", () => {
  it("limits login attempts", () => {
    expect(RATE_LIMIT.LOGIN_PER_MINUTE).toBeGreaterThan(0);
    expect(RATE_LIMIT.LOGIN_PER_MINUTE).toBeLessThanOrEqual(20);
  });

  it("limits signup attempts", () => {
    expect(RATE_LIMIT.SIGNUP_PER_MINUTE).toBeGreaterThan(0);
    expect(RATE_LIMIT.SIGNUP_PER_MINUTE).toBeLessThanOrEqual(10);
  });
});

describe("RATE_LIMIT_TIERS", () => {
  it("anonymous has lowest request limit", () => {
    expect(RATE_LIMIT_TIERS.anonymous.requests).toBeLessThan(RATE_LIMIT_TIERS.starter.requests);
  });

  it("tiers are ordered by increasing limits", () => {
    expect(RATE_LIMIT_TIERS.starter.requests).toBeLessThan(RATE_LIMIT_TIERS.business.requests);
    expect(RATE_LIMIT_TIERS.business.requests).toBeLessThan(RATE_LIMIT_TIERS.enterprise.requests);
  });

  it("all tiers have 60s windows", () => {
    for (const tier of Object.values(RATE_LIMIT_TIERS)) {
      expect(tier.windowMs).toBe(60_000);
    }
  });
});

describe("RATE_LIMIT_COST", () => {
  it("default cost is 1", () => {
    expect(RATE_LIMIT_COST.default).toBe(1);
  });

  it("ai_chat is the most expensive operation", () => {
    const costs = Object.values(RATE_LIMIT_COST);
    expect(RATE_LIMIT_COST.ai_chat).toBe(Math.max(...costs));
  });

  it("all costs are positive integers", () => {
    for (const cost of Object.values(RATE_LIMIT_COST)) {
      expect(cost).toBeGreaterThan(0);
      expect(Number.isInteger(cost)).toBe(true);
    }
  });
});

describe("COOKIE", () => {
  it("session max age is 7 days in seconds", () => {
    expect(COOKIE.SESSION_MAX_AGE_SEC).toBe(604800);
  });

  it("cookie names are prefixed with westbridge_", () => {
    expect(COOKIE.CSRF_NAME).toMatch(/^westbridge_/);
    expect(COOKIE.SESSION_NAME).toMatch(/^westbridge_/);
    expect(COOKIE.ACCOUNT_ID_NAME).toMatch(/^westbridge_/);
  });
});

describe("PAGINATION", () => {
  it("has sensible defaults", () => {
    expect(PAGINATION.DEFAULT_PAGE).toBe(1);
    expect(PAGINATION.DEFAULT_PER_PAGE).toBe(20);
    expect(PAGINATION.MAX_PER_PAGE).toBe(100);
  });

  it("max is greater than default", () => {
    expect(PAGINATION.MAX_PER_PAGE).toBeGreaterThan(PAGINATION.DEFAULT_PER_PAGE);
  });
});

describe("LOCALE", () => {
  it("defaults to GYD (Caribbean-first)", () => {
    expect(LOCALE.DEFAULT_CURRENCY).toBe("GYD");
  });

  it("Guyana VAT rate is 14%", () => {
    expect(LOCALE.VAT_RATE_GUYANA).toBe(0.14);
  });
});

describe("CURRENCY_CODES", () => {
  it("includes Caribbean + international currencies", () => {
    expect(CURRENCY_CODES).toContain("GYD");
    expect(CURRENCY_CODES).toContain("USD");
    expect(CURRENCY_CODES).toContain("TTD");
    expect(CURRENCY_CODES).toContain("BBD");
    expect(CURRENCY_CODES).toContain("JMD");
    expect(CURRENCY_CODES).toContain("XCD");
    expect(CURRENCY_CODES).toContain("EUR");
  });

  it("has no duplicates", () => {
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
  });
});

describe("SECURITY", () => {
  it("lockout after 5 failed attempts", () => {
    expect(SECURITY.LOCKOUT_AFTER_FAILED_ATTEMPTS).toBe(5);
  });

  it("lockout duration is 15 minutes", () => {
    expect(SECURITY.LOCKOUT_DURATION_MINUTES).toBe(15);
  });

  it("max body is 1MB", () => {
    expect(SECURITY.MAX_BODY_BYTES).toBe(1_048_576);
  });

  it("idle timeout is 30 minutes", () => {
    expect(SECURITY.IDLE_TIMEOUT_MINUTES).toBe(30);
  });

  it("max concurrent sessions is bounded", () => {
    expect(SECURITY.MAX_CONCURRENT_SESSIONS).toBeGreaterThan(0);
    expect(SECURITY.MAX_CONCURRENT_SESSIONS).toBeLessThanOrEqual(10);
  });
});
