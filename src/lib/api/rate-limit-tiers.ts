/**
 * Tiered rate limiting with sliding window.
 * Returns standard RateLimit-* headers on every response.
 */
import { getRedis } from "../redis.js";
import { logger } from "../logger.js";
import { RATE_LIMIT_TIERS, RATE_LIMIT_COST } from "../constants.js";

export type RateLimitTier = "anonymous" | "authenticated" | "api_key" | "admin";

const TIER_LIMITS: Record<RateLimitTier, number> = {
  anonymous: 20,
  authenticated: 100,
  api_key: 1000,
  admin: 5000,
};

/** Per-endpoint overrides (requests per window). */
const ENDPOINT_OVERRIDES: Record<string, number> = {
  "/api/auth/login": 10,
  "/api/auth/forgot-password": 5,
  "/api/auth/reset-password": 5,
  "/api/invite/accept": 10,
  "/api/signup": 5,
  "/api/invite": 10,
  "/api/invite:get": 20,
  "/api/account/profile": 10,
  "/api/erp/list": 60,
  "/api/erp/doc": 60,
  "/api/erp/dashboard": 30,
  "/api/team": 30,
  "/api/usage": 30,
  "/api/analytics/vitals": 30,
  "/api/analytics/track": 60,
  "/api/ai/chat": 30,
  "/api/audit/export": 5,
  "/api/auth/change-password": 5,
  "/api/webhooks/2checkout": 100,
};

/** Per-endpoint window in ms (default 60_000). */
const ENDPOINT_WINDOW_MS: Record<string, number> = {
  "/api/audit/export": 60 * 60 * 1000,
};

/** Global per-email rate limit (auth endpoints): 5 requests per minute across login, forgot-password, signup. */
const EMAIL_RATE_LIMIT = 5;
const EMAIL_WINDOW_MS = 60_000;

export function getClientIdentifier(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0]?.trim() : null;
  return ip ?? request.headers.get("x-real-ip") ?? "anonymous";
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix timestamp (seconds) when the window resets */
  reset: number;
  /** Seconds to wait before retrying (only set when not allowed) */
  retryAfter?: number;
}

/**
 * Check rate limit using a sliding window stored in Redis as a sorted set.
 * @param windowMs - Optional window in ms (default 60_000). Used e.g. for /api/audit/export (1hr).
 */
export async function checkTieredRateLimit(
  identifier: string,
  tier: RateLimitTier,
  endpoint?: string,
  costMultiplier = 1,
  windowMsOverride?: number
): Promise<RateLimitResult> {
  const windowMs = windowMsOverride ?? (endpoint ? ENDPOINT_WINDOW_MS[endpoint] : undefined) ?? 60_000;
  const now = Date.now();
  const windowStart = now - windowMs;
  const reset = Math.ceil((now + windowMs) / 1000);

  const tierLimit = TIER_LIMITS[tier];
  const endpointLimit = endpoint ? ENDPOINT_OVERRIDES[endpoint] : undefined;
  const limit = endpointLimit ?? tierLimit;

  const redis = getRedis();
  if (!redis) {
    logger.warn("Rate limit: Redis unavailable, denying request");
    return { allowed: false, limit, remaining: 0, reset, retryAfter: 60 };
  }

  const key = `rl2:${tier}:${identifier}`;

  try {
    // Phase 1: clean stale entries and check current count BEFORE adding.
    const checkPipeline = redis.pipeline();
    checkPipeline.zremrangebyscore(key, 0, windowStart);
    checkPipeline.zcard(key);
    const checkResults = await checkPipeline.exec();

    const currentCount = ((checkResults?.[1]?.[1] as number) ?? 0) * costMultiplier;

    // Reject if the limit is already reached — without consuming a token.
    if (currentCount >= limit) {
      return { allowed: false, limit, remaining: 0, reset, retryAfter: Math.ceil(windowMs / 1000) };
    }

    // Phase 2: add the request now that we know it's within limits.
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const addPipeline = redis.pipeline();
    addPipeline.zadd(key, now, member);
    addPipeline.pexpire(key, windowMs * 2);
    await addPipeline.exec();

    const newCount = currentCount + 1 * costMultiplier;
    const remaining = Math.max(0, limit - newCount);
    return { allowed: true, limit, remaining, reset };
  } catch (e) {
    logger.warn("Rate limit: Redis error", { error: e instanceof Error ? e.message : String(e) });
    return { allowed: false, limit, remaining: 0, reset, retryAfter: 60 };
  }
}

/**
 * Check global per-email rate limit for auth endpoints (login, forgot-password, signup).
 * Prevents spreading brute-force attempts across endpoints.
 */
export async function checkEmailRateLimit(email: string): Promise<RateLimitResult> {
  const normalised = email.trim().toLowerCase();
  const key = `rl2:email:${normalised}`;
  const now = Date.now();
  const windowStart = now - EMAIL_WINDOW_MS;
  const reset = Math.ceil((now + EMAIL_WINDOW_MS) / 1000);

  const redis = getRedis();
  if (!redis) {
    logger.warn("Rate limit: Redis unavailable, denying request");
    return { allowed: false, limit: EMAIL_RATE_LIMIT, remaining: 0, reset, retryAfter: 60 };
  }

  try {
    // Phase 1: clean stale entries and check current count BEFORE adding.
    const checkPipeline = redis.pipeline();
    checkPipeline.zremrangebyscore(key, 0, windowStart);
    checkPipeline.zcard(key);
    const checkResults = await checkPipeline.exec();
    const currentCount = (checkResults?.[1]?.[1] as number) ?? 0;

    if (currentCount >= EMAIL_RATE_LIMIT) {
      return { allowed: false, limit: EMAIL_RATE_LIMIT, remaining: 0, reset, retryAfter: Math.ceil(EMAIL_WINDOW_MS / 1000) };
    }

    // Phase 2: add the request now that we know it's within limits.
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const addPipeline = redis.pipeline();
    addPipeline.zadd(key, now, member);
    addPipeline.pexpire(key, EMAIL_WINDOW_MS * 2);
    await addPipeline.exec();

    const remaining = Math.max(0, EMAIL_RATE_LIMIT - (currentCount + 1));
    return { allowed: true, limit: EMAIL_RATE_LIMIT, remaining, reset };
  } catch (e) {
    logger.warn("Rate limit: Redis error", { error: e instanceof Error ? e.message : String(e) });
    return { allowed: false, limit: EMAIL_RATE_LIMIT, remaining: 0, reset, retryAfter: 60 };
  }
}

/** Per-account ERP limit: 200 requests per minute (prevents single tenant DDoSing shared ERPNext). */
const ERP_ACCOUNT_LIMIT = 200;
const ERP_ACCOUNT_WINDOW_MS = 60_000;

export async function checkErpAccountRateLimit(accountId: string): Promise<RateLimitResult> {
  const key = `rl2:erp:${accountId}`;
  const now = Date.now();
  const windowStart = now - ERP_ACCOUNT_WINDOW_MS;
  const reset = Math.ceil((now + ERP_ACCOUNT_WINDOW_MS) / 1000);

  const redis = getRedis();
  if (!redis) {
    logger.warn("Rate limit: Redis unavailable, denying request");
    return { allowed: false, limit: ERP_ACCOUNT_LIMIT, remaining: 0, reset, retryAfter: 60 };
  }

  try {
    // Phase 1: clean stale entries and check current count BEFORE adding.
    const checkPipeline = redis.pipeline();
    checkPipeline.zremrangebyscore(key, 0, windowStart);
    checkPipeline.zcard(key);
    const checkResults = await checkPipeline.exec();
    const currentCount = (checkResults?.[1]?.[1] as number) ?? 0;

    if (currentCount >= ERP_ACCOUNT_LIMIT) {
      return { allowed: false, limit: ERP_ACCOUNT_LIMIT, remaining: 0, reset, retryAfter: Math.ceil(ERP_ACCOUNT_WINDOW_MS / 1000) };
    }

    // Phase 2: add the request now that we know it's within limits.
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const addPipeline = redis.pipeline();
    addPipeline.zadd(key, now, member);
    addPipeline.pexpire(key, ERP_ACCOUNT_WINDOW_MS * 2);
    await addPipeline.exec();

    const remaining = Math.max(0, ERP_ACCOUNT_LIMIT - (currentCount + 1));
    return { allowed: true, limit: ERP_ACCOUNT_LIMIT, remaining, reset };
  } catch (e) {
    logger.warn("Rate limit: Redis error", { error: e instanceof Error ? e.message : String(e) });
    return { allowed: false, limit: ERP_ACCOUNT_LIMIT, remaining: 0, reset, retryAfter: 60 };
  }
}

/** Convert a RateLimitResult to standard HTTP headers. */
export function rateLimitHeaders(result: RateLimitResult, plan?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.reset),
  };
  if (plan) headers["X-RateLimit-Plan"] = plan;
  if (result.retryAfter !== undefined) {
    headers["Retry-After"] = String(result.retryAfter);
  }
  return headers;
}

/**
 * Map a billing plan name to a rate limit tier.
 * Plan names come from the Account.plan field in Prisma.
 */
export function planToTier(plan: string | null | undefined): RateLimitTier {
  switch (plan?.toLowerCase()) {
    case "business":
    case "enterprise":
      return "api_key"; // highest authenticated tier
    case "growth":
    case "professional":
      return "authenticated";
    case "starter":
    default:
      return "authenticated";
  }
}

/**
 * Get the effective rate limit for a plan + operation combination.
 * Uses RATE_LIMIT_TIERS and RATE_LIMIT_COST from constants as the single source of truth.
 */
export function getPlanRateLimit(
  plan: string,
  operation: string = "default"
): { limit: number; windowMs: number } {
  const planKey = plan.toLowerCase() as keyof typeof RATE_LIMIT_TIERS;
  const tier = RATE_LIMIT_TIERS[planKey] ?? RATE_LIMIT_TIERS.starter;
  const cost = RATE_LIMIT_COST[operation as keyof typeof RATE_LIMIT_COST] ?? RATE_LIMIT_COST.default;
  return {
    limit: Math.floor(tier.requests / cost),
    windowMs: tier.windowMs,
  };
}
