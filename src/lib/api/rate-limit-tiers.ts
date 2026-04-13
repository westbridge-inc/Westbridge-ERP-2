/**
 * Tiered rate limiting with sliding window.
 * Returns standard RateLimit-* headers on every response.
 *
 * REDIS-DOWN BEHAVIOUR (M7 — explicit fail-mode policy)
 * ─────────────────────────────────────────────────────
 *
 * Endpoints fall into two categories with deliberately different behaviour
 * when the Redis backing store is unavailable (down, network partition,
 * pipeline error). The choice of fail-open vs fail-closed is a security ↔
 * availability trade-off and we make it explicit per endpoint:
 *
 *   FAIL-CLOSED (security wins, availability loses)
 *     Authentication / credential-handling / account-creation endpoints.
 *     If we cannot enforce rate limiting, an attacker could brute-force
 *     login/2FA/reset endpoints with no ceiling. The cost of letting that
 *     happen is much higher than the cost of locking everyone out for the
 *     duration of a Redis incident, so we deny these requests.
 *
 *   FAIL-OPEN-WITH-CEILING (availability wins, security degrades gracefully)
 *     Everything else (read APIs, ERP doc fetches, AI chat, dashboards,
 *     analytics beacon). If Redis is down we let the request through and
 *     log a security event, so the platform stays usable while ops fixes
 *     the underlying outage. Without this, a Redis hiccup would manifest
 *     as a 100 % availability incident — much worse than a 30-minute
 *     window of un-rate-limited reads.
 *
 * Both modes log a `warn`-level event on every Redis failure so SLO
 * dashboards see the degraded state and the SRE on-call gets paged.
 *
 * The fail-mode for an endpoint is keyed off `ENDPOINT_FAIL_MODE` below.
 * Endpoints not listed default to FAIL-OPEN-WITH-CEILING.
 */
import { getRedis } from "../redis.js";
import { logger } from "../logger.js";
import { RATE_LIMIT_TIERS, RATE_LIMIT_COST } from "../constants.js";

export type RateLimitTier = "anonymous" | "authenticated" | "api_key" | "admin";

/**
 * Per-endpoint fail-mode policy. See the file header comment for the
 * reasoning behind each category.
 *
 *   "closed" — auth-shaped endpoints. Brute-force attack surface. Block
 *              all requests during a Redis outage so we don't lose the
 *              rate-limit safety net at the worst possible moment.
 *
 *   "open"   — application endpoints. Brief degraded mode is preferable
 *              to a hard outage.
 */
type FailMode = "closed" | "open";
const ENDPOINT_FAIL_MODE: Record<string, FailMode> = {
  "/api/auth/login": "closed",
  "/api/auth/forgot-password": "closed",
  "/api/auth/reset-password": "closed",
  "/api/auth/change-password": "closed",
  "/api/auth/2fa/verify": "closed",
  "/api/auth/2fa/setup": "closed",
  "/api/auth/2fa/disable": "closed",
  "/api/signup": "closed",
  "/api/invite": "closed",
  "/api/invite/accept": "closed",
  "/api/sso/authorize": "closed",
  "/api/webhooks/paddle": "closed", // signature is verified separately, but we still want a rate-limit ceiling
};
const DEFAULT_FAIL_MODE: FailMode = "open";

/**
 * Per-tenant ceiling enforced when fail-OPEN mode is active. Without
 * this, a Redis outage during a high-traffic period could let a single
 * client burst the API into a real overload. We use an in-process
 * counter (Map) as a coarse last-resort throttle that survives Redis
 * being entirely unreachable. The ceiling is intentionally generous —
 * enough headroom for normal traffic, low enough to stop the worst-case
 * abuse while we wait for ops to bring Redis back.
 */
const FAIL_OPEN_CEILING_PER_KEY = 600; // requests / minute / identifier
const FAIL_OPEN_CEILING_WINDOW_MS = 60_000;
const failOpenCounters = new Map<string, { count: number; resetAt: number }>();

function failOpenAllow(key: string): boolean {
  const now = Date.now();
  const entry = failOpenCounters.get(key);
  if (!entry || entry.resetAt < now) {
    failOpenCounters.set(key, { count: 1, resetAt: now + FAIL_OPEN_CEILING_WINDOW_MS });
    return true;
  }
  if (entry.count >= FAIL_OPEN_CEILING_PER_KEY) return false;
  entry.count += 1;
  return true;
}

// Periodic GC so the Map doesn't grow unbounded under sustained Redis outages.
// Runs every 5 minutes; cheap O(n) sweep over expired entries.
const FAIL_OPEN_GC_INTERVAL_MS = 5 * 60_000;
if (process.env.NODE_ENV !== "test") {
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of failOpenCounters.entries()) {
      if (v.resetAt < now) failOpenCounters.delete(k);
    }
  }, FAIL_OPEN_GC_INTERVAL_MS).unref();
}

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
  "/api/auth/2fa/verify": 5,
  "/api/auth/2fa/setup": 5,
  "/api/auth/2fa/disable": 5,
  "/api/sso/authorize": 10,
  "/api/erp/doc/pdf": 10,
  "/api/erp/doc/email": 5,
  "/api/erp/doc/upload": 10,
  "/api/webhooks/paddle": 100,
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

// ---------------------------------------------------------------------------
// Shared sliding window implementation
// ---------------------------------------------------------------------------

/**
 * Generic sliding window rate limiter backed by a Redis sorted set.
 *
 * Algorithm:
 *   1. Remove entries older than `windowMs` (v1.0 pipeline).
 *   2. Count remaining entries — reject if >= `limit`.
 *   3. Add the new request entry (v2.0 pipeline).
 *
 * This two-phase approach ensures we never consume a token when the
 * caller is already over the limit.
 */
async function slidingWindowRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  costMultiplier = 1,
  failMode: FailMode = DEFAULT_FAIL_MODE,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const reset = Math.ceil((now + windowMs) / 1000);

  const redis = getRedis();
  if (!redis) {
    return handleRedisUnavailable(key, limit, reset, failMode, "Redis client not initialised");
  }

  try {
    // v1.0: clean stale entries and check current count BEFORE adding.
    const checkPipeline = redis.pipeline();
    checkPipeline.zremrangebyscore(key, 0, windowStart);
    checkPipeline.zcard(key);
    const checkResults = await checkPipeline.exec();

    const currentCount = ((checkResults?.[1]?.[1] as number) ?? 0) * costMultiplier;

    // Reject if the limit is already reached — without consuming a token.
    if (currentCount >= limit) {
      return { allowed: false, limit, remaining: 0, reset, retryAfter: Math.ceil(windowMs / 1000) };
    }

    // v2.0: add the request now that we know it's within limits.
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const addPipeline = redis.pipeline();
    addPipeline.zadd(key, now, member);
    addPipeline.pexpire(key, windowMs * 2);
    await addPipeline.exec();

    const newCount = currentCount + 1 * costMultiplier;
    const remaining = Math.max(0, limit - newCount);
    return { allowed: true, limit, remaining, reset };
  } catch (e) {
    return handleRedisUnavailable(key, limit, reset, failMode, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Single point of decision for what to do when Redis fails. Centralised
 * here so the fail-mode policy stays consistent across every call site
 * and is easy to audit.
 */
function handleRedisUnavailable(
  key: string,
  limit: number,
  reset: number,
  failMode: FailMode,
  errorMessage: string,
): RateLimitResult {
  if (failMode === "closed") {
    // Auth-shaped endpoint — fail closed. Brute-force protection beats
    // availability here.
    logger.warn("Rate limit: Redis unavailable, FAIL-CLOSED for security-critical endpoint", {
      key,
      error: errorMessage,
    });
    return { allowed: false, limit, remaining: 0, reset, retryAfter: 60 };
  }
  // Application endpoint — fail open with the in-process ceiling so a
  // Redis outage degrades the platform instead of taking it down.
  const allowed = failOpenAllow(key);
  if (!allowed) {
    logger.warn(
      "Rate limit: Redis unavailable AND in-process fail-open ceiling exceeded — denying to protect upstream",
      { key, ceiling: FAIL_OPEN_CEILING_PER_KEY, windowMs: FAIL_OPEN_CEILING_WINDOW_MS, error: errorMessage },
    );
    return { allowed: false, limit, remaining: 0, reset, retryAfter: 60 };
  }
  logger.warn("Rate limit: Redis unavailable, FAIL-OPEN with in-process ceiling (degraded mode)", {
    key,
    error: errorMessage,
  });
  return { allowed: true, limit, remaining: limit, reset };
}

// ---------------------------------------------------------------------------
// Public rate limit functions
// ---------------------------------------------------------------------------

/**
 * Check rate limit using a sliding window stored in Redis as a sorted set.
 * @param windowMs - Optional window in ms (default 60_000). Used e.g. for /api/audit/export (1hr).
 *
 * Fail-mode is selected per endpoint via `ENDPOINT_FAIL_MODE`. Auth-shaped
 * endpoints fail-closed; everything else fails-open with an in-process
 * ceiling. See the file header comment for the full policy.
 */
export async function checkTieredRateLimit(
  identifier: string,
  tier: RateLimitTier,
  endpoint?: string,
  costMultiplier = 1,
  windowMsOverride?: number,
): Promise<RateLimitResult> {
  const windowMs = windowMsOverride ?? (endpoint ? ENDPOINT_WINDOW_MS[endpoint] : undefined) ?? 60_000;

  const tierLimit = TIER_LIMITS[tier];
  const endpointLimit = endpoint ? ENDPOINT_OVERRIDES[endpoint] : undefined;
  const limit = endpointLimit ?? tierLimit;

  const failMode = (endpoint ? ENDPOINT_FAIL_MODE[endpoint] : undefined) ?? DEFAULT_FAIL_MODE;
  const key = `rl2:${tier}:${identifier}`;
  return slidingWindowRateLimit(key, limit, windowMs, costMultiplier, failMode);
}

/**
 * Check global per-email rate limit for auth endpoints (login, forgot-password, signup).
 * Prevents spreading brute-force attempts across endpoints.
 *
 * ALWAYS fail-closed because it's an auth-shaped check by definition.
 */
export async function checkEmailRateLimit(email: string): Promise<RateLimitResult> {
  const normalised = email.trim().toLowerCase();
  const key = `rl2:email:${normalised}`;
  return slidingWindowRateLimit(key, EMAIL_RATE_LIMIT, EMAIL_WINDOW_MS, 1, "closed");
}

/** Per-account ERP limit: 200 requests per minute (prevents single tenant DDoSing shared ERPNext). */
const ERP_ACCOUNT_LIMIT = 200;
const ERP_ACCOUNT_WINDOW_MS = 60_000;

/**
 * ERP account quota — fail-OPEN. ERPNext will reject the burst itself if
 * Redis is down and the in-process ceiling is exceeded; meanwhile a brief
 * Redis outage shouldn't kill every paying customer's data fetches.
 */
export async function checkErpAccountRateLimit(accountId: string): Promise<RateLimitResult> {
  const key = `rl2:erp:${accountId}`;
  return slidingWindowRateLimit(key, ERP_ACCOUNT_LIMIT, ERP_ACCOUNT_WINDOW_MS, 1, "open");
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
export function getPlanRateLimit(plan: string, operation: string = "default"): { limit: number; windowMs: number } {
  const planKey = plan.toLowerCase() as keyof typeof RATE_LIMIT_TIERS;
  const tier = RATE_LIMIT_TIERS[planKey] ?? RATE_LIMIT_TIERS.starter;
  const cost = RATE_LIMIT_COST[operation as keyof typeof RATE_LIMIT_COST] ?? RATE_LIMIT_COST.default;
  return {
    limit: Math.floor(tier.requests / cost),
    windowMs: tier.windowMs,
  };
}
