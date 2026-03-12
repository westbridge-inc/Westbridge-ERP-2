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
    next();
  } catch {
    res.status(500).json({ ok: false, error: { code: "AUTH_ERROR", message: "Authentication check failed" } });
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
      res.status(429).set(rateLimitHeaders(result)).json(
        apiError("RATE_LIMITED", "Too many requests. Please try again shortly.")
      );
      return;
    }
    next();
  };
}
