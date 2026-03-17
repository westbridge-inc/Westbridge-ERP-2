/**
 * Express auth middleware: validates session cookie and attaches session data to the request.
 */

import type { Request, Response, NextFunction } from "express";
import { validateSession } from "../lib/services/session.service.js";
import { COOKIE, COOKIE_SAME_SITE, COOKIE_SECURE } from "../lib/constants.js";
import { hasPermission, type Permission } from "../lib/rbac.js";
import { logAudit } from "../lib/services/audit.service.js";
import { validateCsrf, CSRF_COOKIE_NAME } from "../lib/csrf.js";
import { apiError } from "../types/api.js";
import { prisma } from "../lib/data/prisma.js";
import {
  checkTieredRateLimit,
  getClientIdentifier,
  rateLimitHeaders,
  type RateLimitTier,
} from "../lib/api/rate-limit-tiers.js";

/**
 * Routes that expired/suspended accounts can still access.
 * Users need billing + account + auth routes to reactivate their subscription.
 */
const SUBSCRIPTION_EXEMPT_PREFIXES = ["/api/auth/", "/api/billing/", "/api/account/", "/api/webhooks/", "/api/csrf"];

/** Account statuses that should block API access. */
const BLOCKED_STATUSES = new Set(["past_due", "suspended", "canceled", "cancelled"]);

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

    // Check if the account's subscription is still active (skip for billing/auth routes)
    const isExempt = SUBSCRIPTION_EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix));
    if (!isExempt) {
      try {
        const account = await prisma.account.findUnique({
          where: { id: result.data.accountId },
          select: { status: true },
        });

        if (account && BLOCKED_STATUSES.has(account.status)) {
          res.status(403).json({
            ok: false,
            error: {
              code: "SUBSCRIPTION_INACTIVE",
              message: "Your subscription has expired. Please update your billing to continue.",
            },
          });
          return;
        }
      } catch {
        // If the account lookup fails, let the request through rather than blocking
        // a paying customer due to a transient DB error.
      }
    }

    next();
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
    const account = await prisma.account.findUnique({
      where: { id: session.accountId },
      select: { status: true },
    });

    if (account?.status === "past_due") {
      res.status(402).json({
        ok: false,
        error: {
          code: "SUBSCRIPTION_PAST_DUE",
          message: "Your subscription is past due. Please update your payment method to continue.",
        },
      });
      return;
    }

    if (account?.status === "canceled") {
      res.status(402).json({
        ok: false,
        error: {
          code: "SUBSCRIPTION_CANCELED",
          message: "Your subscription has been canceled. Please resubscribe to continue.",
        },
      });
      return;
    }

    next();
  } catch {
    // Don't block access on DB errors — fail open for availability
    next();
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
      void logAudit({
        accountId: session.accountId,
        userId: session.userId,
        action: "permission.denied",
        resourceId: req.path,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? "unknown",
        severity: "warn",
        outcome: "failure",
        metadata: { required: permission, actual_role: session.role, path: req.path, method: req.method },
      });

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
