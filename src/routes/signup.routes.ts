import { Router, Request, Response } from "express";
import {
  checkTieredRateLimit,
  checkEmailRateLimit,
  getClientIdentifier,
  rateLimitHeaders,
} from "../lib/api/rate-limit-tiers.js";
import { createAccount } from "../lib/services/billing.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { signupBodySchema } from "../types/schemas/signup.js";
import { validateCsrf, CSRF_COOKIE_NAME } from "../lib/csrf.js";
import { toWebRequest } from "../middleware/auth.js";
import * as Sentry from "@sentry/node";

const router = Router();

const MAX_BODY_BYTES = 1_048_576;

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "tempmail.com",
  "10minutemail.com",
  "throwaway.email",
  "yopmail.com",
  "sharklasers.com",
  "guerrillamailblock.com",
  "grr.la",
  "spam4.me",
  "trashmail.com",
  "maildrop.cc",
  "dispostable.com",
  "fakeinbox.com",
  "spamgourmet.com",
  "mytemp.email",
  "temp-mail.org",
  "discard.email",
  "spamex.com",
  "trashmail.net",
]);

// ─── POST /signup ──────────────────────────────────────────────────────────────

router.post("/signup", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseHeaders = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    const contentLength = parseInt((req.headers["content-length"] as string) ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      res.set(responseHeaders());
      return res.status(413).json(apiError("PAYLOAD_TOO_LARGE", "Request body exceeds 1MB limit", undefined, meta()));
    }

    const ctx = auditContext(toWebRequest(req));
    const id = getClientIdentifier(toWebRequest(req));
    const rateLimit = await checkTieredRateLimit(id, "anonymous", "/api/signup");
    if (!rateLimit.allowed) {
      const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
      if (systemAccountId) {
        void logAudit({
          accountId: systemAccountId,
          action: "account.signup.rate_limited",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "warn",
          outcome: "failure",
        });
      }
      res.set({ ...responseHeaders(), ...rateLimitHeaders(rateLimit) });
      return res
        .status(429)
        .json(apiError("RATE_LIMIT", "Too many signup attempts. Try again in a minute.", undefined, meta()));
    }

    const csrfCookie = req.cookies[CSRF_COOKIE_NAME];
    const csrfHeader = (req.headers["x-csrf-token"] as string) ?? (req.headers["X-CSRF-Token"] as string);
    if (!validateCsrf(csrfHeader, csrfCookie)) {
      const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
      if (systemAccountId) {
        void logAudit({
          accountId: systemAccountId,
          action: "auth.signup.csrf_failure",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "warn",
          outcome: "failure",
        });
      }
      res.set(responseHeaders());
      return res.status(403).json(apiError("FORBIDDEN", "Invalid or missing CSRF token.", undefined, meta()));
    }

    const body = req.body;
    if (!body || Object.keys(body).length === 0) {
      res.set(responseHeaders());
      return res.status(400).json(apiError("INVALID_JSON", "Invalid request body", undefined, meta()));
    }

    const parsed = signupBodySchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.flatten().fieldErrors;
      const message =
        first.email?.[0] ??
        first.name?.[0] ??
        first.password?.[0] ??
        first.companyName?.[0] ??
        first.plan?.[0] ??
        "Invalid request";
      res.set(responseHeaders());
      return res.status(400).json(apiError("VALIDATION_ERROR", message, undefined, meta()));
    }

    const emailDomain = parsed.data.email.split("@")[1]?.toLowerCase();
    if (emailDomain && DISPOSABLE_EMAIL_DOMAINS.has(emailDomain)) {
      res.set(responseHeaders());
      return res
        .status(400)
        .json(apiError("VALIDATION_ERROR", "Disposable email addresses are not allowed.", undefined, meta()));
    }

    const emailRateLimit = await checkEmailRateLimit(parsed.data.email);
    if (!emailRateLimit.allowed) {
      const systemAccountIdForAudit = process.env.SYSTEM_ACCOUNT_ID;
      if (systemAccountIdForAudit) {
        void logAudit({
          accountId: systemAccountIdForAudit,
          action: "account.signup.rate_limited",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "warn",
          outcome: "failure",
        });
      }
      res.set({ ...responseHeaders(), ...rateLimitHeaders(emailRateLimit) });
      return res
        .status(429)
        .json(apiError("RATE_LIMIT", "Too many attempts. Try again in a minute.", undefined, meta()));
    }

    const result = await createAccount({ ...parsed.data, request: toWebRequest(req) });

    if (!result.ok) {
      // Map known safe messages to appropriate status codes
      const safeErrorMap: Record<string, number> = {
        "An account with this email already exists. Please sign in.": 409,
        "Email, company name, and plan are required": 400,
        "Invalid plan": 400,
        "Unable to create your account right now. Please try again.": 500,
      };
      const status = safeErrorMap[result.error] ?? 500;
      const message =
        safeErrorMap[result.error] !== undefined
          ? result.error
          : "Unable to create your account right now. Please try again.";
      const { logger } = await import("../lib/logger.js");
      if (status === 500) logger.error("Signup API error", { error: result.error, request_id: requestId });
      const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
      if (systemAccountId) {
        void logAudit({
          accountId: systemAccountId,
          action: "account.signup.failure",
          metadata: { reason: result.error },
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "warn",
          outcome: "failure",
        });
      }
      res.set(responseHeaders());
      return res.status(status).json(apiError("SIGNUP_FAILED", message, undefined, meta()));
    }

    void logAudit({
      accountId: result.data.accountId,
      action: "account.created",
      metadata: { email: parsed.data.email, plan: parsed.data.plan },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });

    res.set(responseHeaders());
    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
});

export default router;
