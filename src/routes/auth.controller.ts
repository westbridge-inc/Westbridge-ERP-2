/**
 * Auth controller — business logic extracted from auth.routes.ts.
 *
 * Each function receives validated/parsed data and returns a result
 * that the thin route handler translates into an HTTP response.
 */

import { z } from "zod";
import * as Sentry from "@sentry/node";

import {
  checkTieredRateLimit,
  checkEmailRateLimit,
  getClientIdentifier,
  rateLimitHeaders,
} from "../lib/api/rate-limit-tiers.js";
import { login as erpLogin, changePassword as erpChangePassword } from "../lib/services/auth.service.js";
import { createSession, validateSession, revokeSession } from "../lib/services/session.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { loginBodySchema, changePasswordBodySchema } from "../types/schemas/auth.js";
import { prisma } from "../lib/data/prisma.js";
import { COOKIE, COOKIE_SAME_SITE, COOKIE_SECURE } from "../lib/constants.js";
import { reportSecurityEvent } from "../lib/security-monitor.js";
import { toWebRequest } from "../middleware/auth.js";
import { requestPasswordReset, applyPasswordReset } from "../lib/services/password-reset.service.js";
import { validatePassword } from "../lib/password-policy.js";

import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_048_576;

type MetaFn = () => ReturnType<typeof apiMeta>;
type ResponseTimeFn = () => Record<string, string>;

interface RequestContext {
  requestId: string;
  meta: MetaFn;
  responseTime: ResponseTimeFn;
}

function buildContext(req: Request): RequestContext {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  return {
    requestId,
    meta: () => apiMeta({ request_id: requestId }),
    responseTime: () => ({ "X-Response-Time": `${Date.now() - start}ms` }),
  };
}

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------

export async function handleLogin(req: Request, res: Response): Promise<Response> {
  const { requestId, meta, responseTime } = buildContext(req);
  const ctx = auditContext(toWebRequest(req));

  try {
    // --- Payload size guard ---
    const contentLength = parseInt((req.headers["content-length"] as string) ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      return res
        .status(413)
        .set(responseTime())
        .json(apiError("PAYLOAD_TOO_LARGE", "Request body exceeds 1MB limit", undefined, meta()));
    }

    // --- IP / anonymous rate limit ---
    const id = getClientIdentifier(toWebRequest(req));
    const rateLimit = await checkTieredRateLimit(id, "anonymous", "/api/auth/login");
    if (!rateLimit.allowed) {
      const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
      if (systemAccountId) {
        void logAudit({
          accountId: systemAccountId,
          action: "auth.login.rate_limited",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "warn",
          outcome: "failure",
        });
      }
      return res
        .status(429)
        .set({ ...responseTime(), ...rateLimitHeaders(rateLimit) })
        .json(apiError("RATE_LIMIT", "Too many attempts. Try again in a minute.", undefined, meta()));
    }

    // --- Body validation via Zod schema ---
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.flatten().fieldErrors;
      const message = first.email?.[0] ?? first.password?.[0] ?? "Invalid request";
      return res
        .status(400)
        .set(responseTime())
        .json(apiError("VALIDATION_ERROR", message, undefined, meta()));
    }

    // --- Per-email rate limit ---
    const { email, password } = parsed.data;
    const emailRateLimit = await checkEmailRateLimit(email);
    if (!emailRateLimit.allowed) {
      const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
      if (systemAccountId) {
        void logAudit({
          accountId: systemAccountId,
          action: "auth.login.rate_limited",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "warn",
          outcome: "failure",
        });
      }
      return res
        .status(429)
        .set({ ...responseTime(), ...rateLimitHeaders(emailRateLimit) })
        .json(apiError("RATE_LIMIT", "Too many attempts. Try again in a minute.", undefined, meta()));
    }

    // --- Account lookup ---
    const account = await prisma.account.findUnique({ where: { email } }).catch(() => null);
    if (!account) {
      return res
        .status(401)
        .set(responseTime())
        .json(apiError("AUTH_FAILED", "Invalid email or password.", undefined, meta()));
    }

    // --- User lookup / auto-create first owner ---
    let user = await prisma.user.findUnique({
      where: { accountId_email: { accountId: account.id, email } },
    });

    if (!user) {
      const existingCount = await prisma.user.count({
        where: { accountId: account.id },
      });
      if (existingCount > 0) {
        void logAudit({
          accountId: account.id,
          action: "auth.login.user_not_invited",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "warn",
          outcome: "failure",
          metadata: { email },
        });
        return res
          .status(401)
          .set(responseTime())
          .json(apiError("AUTH_FAILED", "Invalid email or password.", undefined, meta()));
      }
      // First user for this account -- create as owner
      user = await prisma.user.create({
        data: {
          accountId: account.id,
          email,
          name: null,
          role: "owner",
          status: "active",
        },
      });
    }

    // --- Account lockout check ---
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      void logAudit({
        accountId: account.id,
        userId: user.id,
        action: "auth.login.account_locked",
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "warn",
        outcome: "failure",
      });
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      return res
        .status(423)
        .set(responseTime())
        .json(
          apiError("ACCOUNT_LOCKED", `Account temporarily locked. Try again in ${mins} minutes.`, undefined, meta()),
        );
    }

    // --- Authenticate against ERPNext ---
    const loginResult = await erpLogin(email, password);

    if (!loginResult.ok) {
      const { logger } = await import("../lib/logger.js");
      logger.warn("Login failed", {
        error: loginResult.error,
        request_id: requestId,
      });
      const nextAttempts = (user.failedLoginAttempts ?? 0) + 1;
      const lockedUntil = nextAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: nextAttempts,
          lastFailedLogin: new Date(),
          ...(lockedUntil ? { lockedUntil } : {}),
        },
      });
      if (lockedUntil) {
        void logAudit({
          accountId: account.id,
          userId: user.id,
          action: "auth.login.account_lockout",
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "critical",
          outcome: "failure",
        });
        reportSecurityEvent({
          type: "brute_force",
          userId: user.id,
          accountId: account.id,
          ipAddress: ctx.ipAddress,
          details: "Account locked after 5 failed login attempts",
        });
      }
      void logAudit({
        accountId: account.id,
        userId: user.id,
        action: "auth.login.failure",
        metadata: { reason: loginResult.error },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "warn",
        outcome: "failure",
      });
      return res
        .status(401)
        .set(responseTime())
        .json(apiError("AUTH_FAILED", "Invalid email or password.", undefined, meta()));
    }

    // --- Reset failed login counter ---
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    // --- Create session ---
    const erpnextSid = loginResult.data;
    const sessionResult = await createSession(user.id, toWebRequest(req), erpnextSid);
    if (!sessionResult.ok) {
      return res
        .status(500)
        .set(responseTime())
        .json(apiError("SESSION_ERROR", "Unable to create your session. Please try again.", undefined, meta()));
    }

    const { token, expiresAt } = sessionResult.data;
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));

    // --- Audit success ---
    void logAudit({
      accountId: account.id,
      userId: user.id,
      action: "auth.login.success",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });

    // --- PostHog identify ---
    const { identify } = await import("../lib/analytics/posthog.server.js");
    identify(user.id, {
      email: user.email,
      plan: account.plan,
      companyName: account.companyName,
    });

    // --- Set session cookie and respond ---
    res.cookie(COOKIE.SESSION_NAME, token, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: COOKIE_SAME_SITE,
      maxAge: maxAge * 1000, // Express expects milliseconds
      path: "/",
    });

    return res
      .status(200)
      .set(responseTime())
      .json(apiSuccess({ success: true }, meta()));
  } catch (error) {
    Sentry.captureException(error, {
      extra: {
        request_id: requestId,
        method: req.method,
        url: req.originalUrl,
      },
    });
    return res
      .status(500)
      .set(responseTime())
      .json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
}

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------

export async function handleLogout(req: Request, res: Response): Promise<Response> {
  const { requestId, responseTime } = buildContext(req);

  const ctx = auditContext(toWebRequest(req));
  const sid = req.cookies?.[COOKIE.SESSION_NAME] ?? undefined;
  if (sid) {
    const sessionResult = await validateSession(sid, toWebRequest(req));
    if (sessionResult.ok) {
      void logAudit({
        accountId: sessionResult.data.accountId,
        userId: sessionResult.data.userId,
        action: "auth.logout",
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "info",
        outcome: "success",
      });
    }
    await revokeSession(sid);
  }

  // Clear cookies
  res.clearCookie(COOKIE.SESSION_NAME, {
    path: "/",
    sameSite: COOKIE_SAME_SITE,
    secure: true,
  });
  res.clearCookie(COOKIE.CSRF_NAME, {
    path: "/",
    sameSite: COOKIE_SAME_SITE,
    secure: true,
  });

  return res
    .status(200)
    .set(responseTime())
    .json(apiSuccess({ loggedOut: true }, { request_id: requestId }));
}

// ---------------------------------------------------------------------------
// GET /validate
// ---------------------------------------------------------------------------

export async function handleValidate(req: Request, res: Response): Promise<Response> {
  const { meta, responseTime } = buildContext(req);
  const ctx = auditContext(toWebRequest(req));

  const token = req.cookies?.[COOKIE.SESSION_NAME] ?? undefined;
  if (!token) {
    return res
      .status(401)
      .set(responseTime())
      .json(apiError("UNAUTHORIZED", "Missing session", undefined, meta()));
  }

  const result = await validateSession(token, toWebRequest(req));
  if (!result.ok) {
    const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
    if (systemAccountId) {
      void logAudit({
        accountId: systemAccountId,
        action: "auth.session.invalid",
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "warn",
        outcome: "failure",
      });
    }
    return res
      .status(401)
      .set(responseTime())
      .json(apiError("UNAUTHORIZED", "Your session has expired. Please log in again.", undefined, meta()));
  }

  // Fetch name + email so the sidebar footer can show the real user
  const user = await prisma.user
    .findUnique({
      where: { id: result.data.userId },
      select: { name: true, email: true },
    })
    .catch(() => null);

  // Fetch trial info for the account
  const account = await prisma.account
    .findUnique({
      where: { id: result.data.accountId },
      select: { trialEndsAt: true, trialAiLimit: true },
    })
    .catch(() => null);

  const now = new Date();
  const isOnTrial = !!(account?.trialEndsAt && account.trialEndsAt > now);
  const trialDaysRemaining = isOnTrial && account?.trialEndsAt
    ? Math.max(0, Math.ceil((account.trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
    : 0;

  return res
    .status(200)
    .set(responseTime())
    .json(
      apiSuccess(
        {
          userId: result.data.userId,
          accountId: result.data.accountId,
          role: result.data.role,
          email: user?.email ?? "",
          name: user?.name ?? "",
          isOnTrial,
          trialEndsAt: account?.trialEndsAt?.toISOString() ?? null,
          trialDaysRemaining,
          trialAiLimit: isOnTrial ? (account?.trialAiLimit ?? 10) : null,
        },
        meta(),
      ),
    );
}

// ---------------------------------------------------------------------------
// POST /forgot-password
// ---------------------------------------------------------------------------

const forgotPasswordBodySchema = z.object({ email: z.string().email() });

export async function handleForgotPassword(req: Request, res: Response): Promise<Response> {
  const { requestId, meta, responseTime } = buildContext(req);

  try {
    const { allowed } = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "anonymous",
      "/api/auth/forgot-password",
    );
    if (!allowed) {
      // Still return 200 to avoid enumeration via timing
      return res
        .status(200)
        .set(responseTime())
        .json(apiSuccess({ sent: true }, meta()));
    }

    // --- Body validation ---
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res
        .status(400)
        .set(responseTime())
        .json(apiError("INVALID_JSON", "Invalid request body", undefined, meta()));
    }

    const parsed = forgotPasswordBodySchema.safeParse(body);
    if (!parsed.success) {
      return res
        .status(400)
        .set(responseTime())
        .json(apiError("VALIDATION_ERROR", "Valid email required", undefined, meta()));
    }

    // --- Per-email rate limit ---
    const emailRateLimit = await checkEmailRateLimit(parsed.data.email);
    if (!emailRateLimit.allowed) {
      // Still return 200 to avoid enumeration
      return res
        .status(200)
        .set(responseTime())
        .json(apiSuccess({ sent: true }, meta()));
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    await requestPasswordReset(parsed.data.email, baseUrl);

    // Always return success -- never reveal whether the email exists
    return res
      .status(200)
      .set(responseTime())
      .json(apiSuccess({ sent: true }, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    // Still return 200 -- don't leak server errors for this endpoint
    return res
      .status(200)
      .set(responseTime())
      .json(apiSuccess({ sent: true }, meta()));
  }
}

// ---------------------------------------------------------------------------
// POST /reset-password
// ---------------------------------------------------------------------------

const resetPasswordBodySchema = z.object({
  token: z.string().min(1),
  password: z.string(),
});

export async function handleResetPassword(req: Request, res: Response): Promise<Response> {
  const { requestId, meta, responseTime } = buildContext(req);

  try {
    const rl = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "anonymous",
      "/api/auth/reset-password",
    );
    if (!rl.allowed) {
      return res
        .status(429)
        .set({ ...responseTime(), ...rateLimitHeaders(rl) })
        .json(apiError("RATE_LIMIT", "Too many attempts. Try again later.", undefined, meta()));
    }

    // --- Body validation ---
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res
        .status(400)
        .set(responseTime())
        .json(apiError("INVALID_JSON", "Invalid request body", undefined, meta()));
    }

    const parsed = resetPasswordBodySchema.safeParse(body);
    if (!parsed.success) {
      return res
        .status(400)
        .set(responseTime())
        .json(apiError("VALIDATION_ERROR", "token and password are required", undefined, meta()));
    }

    const { token, password } = parsed.data;
    const pwCheck = validatePassword(password);
    if (!pwCheck.valid) {
      return res
        .status(400)
        .set(responseTime())
        .json(apiError("VALIDATION_ERROR", pwCheck.errors[0] ?? "Invalid password", undefined, meta()));
    }

    const result = await applyPasswordReset({
      raw: token,
      newPassword: password,
    });
    if (!result.ok) {
      // Sanitize: only pass through known user-facing messages from the reset service
      const safeMessages = [
        "Invalid or expired reset link.",
        "This reset link has already been used.",
        "This reset link has expired. Request a new one.",
        "Failed to update password. Please try again.",
      ];
      const message = safeMessages.includes(result.error)
        ? result.error
        : "Unable to reset your password right now. Please try again.";
      return res
        .status(400)
        .set(responseTime())
        .json(apiError("RESET_FAILED", message, undefined, meta()));
    }

    return res
      .status(200)
      .set(responseTime())
      .json(apiSuccess({ success: true }, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res
      .status(500)
      .set(responseTime())
      .json(apiError("SERVER_ERROR", "An unexpected error occurred", undefined, meta()));
  }
}

// ---------------------------------------------------------------------------
// POST /change-password
// ---------------------------------------------------------------------------

export async function handleChangePassword(req: Request, res: Response): Promise<Response> {
  const { meta, responseTime } = buildContext(req);

  try {
    // --- Session validation ---
    const token = req.cookies?.[COOKIE.SESSION_NAME] ?? undefined;
    if (!token) {
      return res
        .status(401)
        .set(responseTime())
        .json(apiError("UNAUTHORIZED", "Not authenticated", undefined, meta()));
    }
    const session = await validateSession(token, toWebRequest(req));
    if (!session.ok) {
      return res
        .status(401)
        .set(responseTime())
        .json(apiError("UNAUTHORIZED", "Your session has expired. Please log in again.", undefined, meta()));
    }

    // --- Rate limit (authenticated) ---
    const rl = await checkTieredRateLimit(session.data.userId, "authenticated", "/api/auth/change-password");
    if (!rl.allowed) {
      return res
        .status(429)
        .set({ ...responseTime(), ...rateLimitHeaders(rl) })
        .json(apiError("RATE_LIMIT", "Too many attempts. Please wait before trying again.", undefined, meta()));
    }

    // --- Body validation via Zod schema ---
    const bodyParsed = changePasswordBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      const firstError = bodyParsed.error.flatten().fieldErrors;
      const message =
        firstError.currentPassword?.[0] ??
        firstError.newPassword?.[0] ??
        "currentPassword and newPassword are required";
      return res
        .status(400)
        .set(responseTime())
        .json(apiError("VALIDATION", message, undefined, meta()));
    }

    // --- Delegate to service ---
    const result = await erpChangePassword({
      userId: session.data.userId,
      currentPassword: bodyParsed.data.currentPassword,
      newPassword: bodyParsed.data.newPassword,
      sessionToken: token,
    });

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        VALIDATION: 400,
        NOT_FOUND: 404,
        UNAUTHORIZED: 401,
      };
      const status = statusMap[result.error.code] ?? 500;
      return res
        .status(status)
        .set(responseTime())
        .json(apiError(result.error.code, result.error.message, undefined, meta()));
    }

    return res.status(200).set(responseTime()).json(apiSuccess(result.data, meta()));
  } catch (err) {
    Sentry.captureException(err);
    return res
      .status(500)
      .set(responseTime())
      .json(apiError("INTERNAL", "An unexpected error occurred", undefined, meta()));
  }
}
