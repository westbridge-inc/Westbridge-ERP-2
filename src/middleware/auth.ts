/**
 * Express auth middleware: validates session cookie, attaches session
 * data to the request, AND pins the per-request tenant context for
 * RLS-bound Prisma queries.
 *
 * The tenant pin is the runtime side of Phase 3 of the tenant
 * isolation hardening spec. After this middleware validates the
 * session and learns which `accountId` the request belongs to, it runs
 * the rest of the middleware chain inside `tenantContextStorage.run()`.
 * That AsyncLocalStorage value is read by the Prisma `$extends` in
 * `lib/data/prisma.ts` to bind PostgreSQL's `app.current_account_id`
 * for every query the request handler issues.
 *
 * IMPORTANT: this middleware MUST run before any per-tenant Prisma
 * query in the request handler chain. Routes that authenticate via
 * `requireAuth` get the tenant pin for free. Routes that don't need
 * authentication but DO need tenant scoping (e.g. webhook handlers
 * that already verified a signature) must call `runWithTenantContext`
 * directly with the tenant id they verified — see the helper at the
 * bottom of this file.
 */

import type { Request, Response, NextFunction } from "express";
import { validateSession } from "../lib/services/session.service.js";
import { COOKIE, COOKIE_SAME_SITE, COOKIE_SECURE } from "../lib/constants.js";
import { hasPermission, type Permission } from "../lib/rbac.js";
import { logAudit } from "../lib/services/audit.service.js";
import { validateCsrf, CSRF_COOKIE_NAME } from "../lib/csrf.js";
import { apiError } from "../types/api.js";
import { prismaAdmin } from "../lib/data/prisma-admin.js";
import { tenantContextStorage } from "../lib/data/tenant-als.js";
import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import {
  checkTieredRateLimit,
  getClientIdentifier,
  rateLimitHeaders,
  type RateLimitTier,
} from "../lib/api/rate-limit-tiers.js";

export interface SessionData {
  userId: string;
  accountId: string;
  role: string;
  erpnextSid?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      session?: SessionData;
    }
  }
}

/**
 * Middleware that validates the session cookie and attaches session data to req.session.
 * Returns 401 if no valid session exists.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionToken = req.cookies?.[COOKIE.SESSION_NAME];

  if (!sessionToken) {
    res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    return;
  }

  // Reject obviously malformed tokens
  const SESSION_TOKEN_REGEX = /^[A-Za-z0-9\-_]+$/;
  if (!SESSION_TOKEN_REGEX.test(sessionToken)) {
    res.clearCookie(COOKIE.SESSION_NAME, { path: "/", sameSite: COOKIE_SAME_SITE, secure: COOKIE_SECURE });
    res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid session" } });
    return;
  }

  try {
    // Create a minimal Web API Request-like object for the session service
    // since it expects request.headers.get() interface
    const fakeRequest = toWebRequest(req);
    const result = await validateSession(sessionToken, fakeRequest);

    if (!result.ok) {
      res.clearCookie(COOKIE.SESSION_NAME, { path: "/", sameSite: COOKIE_SAME_SITE, secure: COOKIE_SECURE });
      res.status(401).json({ ok: false, error: { code: "SESSION_EXPIRED", message: "Session expired or invalid" } });
      return;
    }

    req.session = result.data;
    // Pin the tenant context for the rest of this request's middleware
    // chain and route handler. AsyncLocalStorage propagates through all
    // promise/await boundaries, so any downstream `prisma.X.method()`
    // call will be wrapped by the tenant-pin extension and run with
    // `app.current_account_id` set in PostgreSQL. RLS policies then
    // filter rows to the requesting tenant.
    //
    // NOTE: cross-tenant lookups (validateSession itself, the
    // requireActiveSubscription cache, audit logging, etc.) use
    // `prismaAdmin` so they bypass this pin — they need to operate
    // before or across the tenant boundary by design.
    tenantContextStorage.run({ accountId: result.data.accountId }, () => next());
  } catch {
    res.status(500).json({ ok: false, error: { code: "AUTH_ERROR", message: "Authentication check failed" } });
  }
}

/**
 * Middleware that checks the account's subscription is active.
 * Blocks access when the account is past_due or canceled, except for
 * billing, auth, and health endpoints so users can still pay or log out.
 *
 * Must be used AFTER requireAuth (which attaches req.session).
 */
const SUBSCRIPTION_EXEMPT_PREFIXES = [
  "/api/billing/",
  "/api/v1/billing/",
  "/api/auth/",
  "/api/v1/auth/",
  "/api/health/",
  "/api/v1/health/",
  "/api/account/",
  "/api/v1/account/",
  "/api/usage",
  "/api/v1/usage",
];

const ACCOUNT_STATUS_CACHE_PREFIX = "account:status:";
const ACCOUNT_STATUS_CACHE_TTL_SEC = 60; // 1 minute cache to avoid DB lookups on every request
const BLOCKED_STATUSES = new Set(["past_due", "suspended", "canceled", "cancelled"]);

interface AccountStatusInfo {
  status: string | null;
  trialEndsAt: Date | null;
}

async function getAccountStatusInfo(accountId: string): Promise<AccountStatusInfo> {
  // Try Redis cache first (status only — trial check needs DB)
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(`${ACCOUNT_STATUS_CACHE_PREFIX}${accountId}`);
      if (cached) {
        // Parse cached trial info if present
        try {
          const parsed = JSON.parse(cached) as { status: string; trialEndsAt: string | null };
          return {
            status: parsed.status,
            trialEndsAt: parsed.trialEndsAt ? new Date(parsed.trialEndsAt) : null,
          };
        } catch {
          // Legacy cache format (plain string status) — fall through to DB
        }
      }
    } catch (e) {
      logger.warn("requireActiveSubscription: Redis cache read failed", {
        accountId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Fall through to DB. Use prismaAdmin (cross-tenant) because
  // requireActiveSubscription runs as part of the auth chain and we
  // can't assume a tenant pin is set yet — and even if it is, looking
  // up an account row by id is exactly the operation that establishes
  // the tenant boundary, so it shouldn't be RLS-filtered.
  const account = await prismaAdmin.account.findUnique({
    where: { id: accountId },
    select: { status: true, trialEndsAt: true },
  });

  const info: AccountStatusInfo = {
    status: account?.status ?? null,
    trialEndsAt: account?.trialEndsAt ?? null,
  };

  // Cache the result in Redis
  if (redis && info.status) {
    const cacheValue = JSON.stringify({
      status: info.status,
      trialEndsAt: info.trialEndsAt?.toISOString() ?? null,
    });
    redis
      .set(`${ACCOUNT_STATUS_CACHE_PREFIX}${accountId}`, cacheValue, "EX", ACCOUNT_STATUS_CACHE_TTL_SEC)
      .catch((e: unknown) =>
        logger.warn("requireActiveSubscription: Redis cache write failed", {
          accountId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }

  return info;
}

export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Allow billing/auth/health endpoints through so users can pay or log out
  if (SUBSCRIPTION_EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }

  const session = req.session;
  if (!session) {
    next();
    return;
  }

  try {
    const { status, trialEndsAt } = await getAccountStatusInfo(session.accountId);

    if (status && BLOCKED_STATUSES.has(status)) {
      // Check if this is specifically a trial expiry
      if (trialEndsAt && trialEndsAt <= new Date()) {
        // Verify no paid subscription exists. Cross-tenant lookup —
        // use prismaAdmin so RLS doesn't gate the cache decision.
        const paidSub = await prismaAdmin.subscription.findFirst({
          where: {
            accountId: session.accountId,
            status: { in: ["active"] },
          },
        });
        if (!paidSub) {
          res.status(403).json({
            ok: false,
            error: {
              code: "TRIAL_EXPIRED",
              message: "Your free trial has expired. Subscribe to a plan to restore access.",
            },
          });
          return;
        }
      }

      res.status(403).json({
        ok: false,
        error: {
          code: "SUBSCRIPTION_EXPIRED",
          message: "Your subscription has expired. Please update your billing.",
        },
      });
      return;
    }

    // Inline trial check: if the account is active but trial has expired and no paid sub
    if (trialEndsAt && trialEndsAt <= new Date()) {
      const paidSub = await prismaAdmin.subscription.findFirst({
        where: {
          accountId: session.accountId,
          status: { in: ["active"] },
        },
      });
      if (!paidSub) {
        res.status(403).json({
          ok: false,
          error: {
            code: "TRIAL_EXPIRED",
            message: "Your free trial has expired. Subscribe to a plan to restore access.",
          },
        });
        return;
      }
    }

    next();
  } catch (err) {
    // Fail closed on DB errors — return 503 instead of silently allowing access
    logger.error("requireActiveSubscription: failed to check account status", {
      accountId: session.accountId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({
      ok: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Unable to verify subscription status. Please try again shortly.",
      },
    });
  }
}

/**
 * Middleware factory: checks that the authenticated user's role has the required permission.
 * Must be used AFTER requireAuth (which attaches req.session).
 */
export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = req.session;

    if (!session) {
      res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } });
      return;
    }

    if (!hasPermission(session.role, permission)) {
      logAudit({
        accountId: session.accountId,
        userId: session.userId,
        action: "permission.denied",
        resourceId: req.path,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? "unknown",
        severity: "warn",
        outcome: "failure",
        metadata: { required: permission, actual_role: session.role, path: req.path, method: req.method },
      }).catch((err: any) => console.error("Background task failed", err));

      res.status(403).json({ ok: false, error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
      return;
    }

    next();
  };
}

/**
 * Creates a minimal Web API Request-like object from an Express request.
 * The session service uses request.headers.get() which is the Web API interface.
 */
export function toWebRequest(req: Request): globalThis.Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }

  const protocol = req.protocol || "http";
  const host = req.get("host") || "localhost";
  const url = `${protocol}://${host}${req.originalUrl}`;

  return new globalThis.Request(url, {
    method: req.method,
    headers,
  });
}

/**
 * Middleware that validates the CSRF token from the request header against the cookie.
 * Returns 403 if the token is missing or invalid.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const headerToken = (req.headers["x-csrf-token"] as string) ?? null;
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME] ?? null;
  if (!validateCsrf(headerToken, cookieToken)) {
    res.status(403).json(apiError("FORBIDDEN", "Invalid or missing CSRF token"));
    return;
  }
  next();
}

/**
 * Run the given async function with the tenant context bound to
 * `accountId`. Use this from non-`requireAuth` code paths that have
 * just verified a tenant some other way (e.g., a webhook handler
 * that already validated the Paddle signature, or an SSO callback
 * that just exchanged a code for a verified user) but still need
 * subsequent Prisma queries to be RLS-pinned.
 *
 * Most code does NOT need this — `requireAuth` handles the common
 * case automatically.
 */
export async function runWithTenantContext<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContextStorage.run({ accountId }, fn);
}

/**
 * Middleware factory: checks the tiered rate limit for the given tier and endpoint.
 * Returns 429 if the rate limit is exceeded.
 */
export function rateLimit(tier: RateLimitTier, endpoint: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identifier = req.session?.userId ?? req.session?.accountId ?? getClientIdentifier(toWebRequest(req));
    const result = await checkTieredRateLimit(identifier, tier, endpoint);
    if (!result.allowed) {
      res
        .status(429)
        .set(rateLimitHeaders(result))
        .json(apiError("RATE_LIMITED", "Too many requests. Please try again shortly."));
      return;
    }
    next();
  };
}
