/**
 * Express router for /api/auth/* routes.
 *
 * Converted from Next.js API route handlers:
 *   - POST /api/auth/login
 *   - POST /api/auth/logout
 *   - GET  /api/auth/validate
 *   - POST /api/auth/forgot-password
 *   - POST /api/auth/reset-password
 *   - POST /api/auth/change-password
 *
 * All business logic is preserved verbatim. Only the HTTP layer (NextResponse,
 * cookies(), etc.) has been adapted for Express + cookie-parser + helmet.
 */

import { Router, Request, Response } from "express";
import { createHash } from "crypto";
import { z } from "zod";
import * as Sentry from "@sentry/node";

import {
  checkTieredRateLimit,
  checkEmailRateLimit,
  getClientIdentifier,
  rateLimitHeaders,
} from "../lib/api/rate-limit-tiers.js";
import { login, hashPassword, verifyPassword } from "../lib/services/auth.service.js";
import {
  createSession,
  validateSession,
  revokeSession,
} from "../lib/services/session.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { loginBodySchema, changePasswordBodySchema } from "../types/schemas/auth.js";
import { prisma } from "../lib/data/prisma.js";
import { COOKIE, COOKIE_SAME_SITE, COOKIE_SECURE } from "../lib/constants.js";
import { reportSecurityEvent } from "../lib/security-monitor.js";
import { toWebRequest, requireCsrf } from "../middleware/auth.js";
import { requestPasswordReset, applyPasswordReset } from "../lib/services/password-reset.service.js";
import { validatePassword } from "../lib/password-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

// ========================== POST /login ====================================
router.post("/login", requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseTime = () => ({ "X-Response-Time": `${Date.now() - start}ms` });
  const ctx = auditContext(toWebRequest(req));

  try {
    // --- Payload size guard ---
    const contentLength = parseInt(
      (req.headers["content-length"] as string) ?? "0",
      10,
    );
    if (contentLength > MAX_BODY_BYTES) {
      return res
        .status(413)
        .set(responseTime())
        .json(
          apiError(
            "PAYLOAD_TOO_LARGE",
            "Request body exceeds 1MB limit",
            undefined,
            meta(),
          ),
        );
    }

    // --- IP / anonymous rate limit ---
    const id = getClientIdentifier(toWebRequest(req));
    const rateLimit = await checkTieredRateLimit(
      id,
      "anonymous",
      "/api/auth/login",
    );
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
        .json(
          apiError(
            "RATE_LIMIT",
            "Too many attempts. Try again in a minute.",
            undefined,
            meta(),
          ),
        );
    }

    // --- Body validation via Zod schema ---
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.flatten().fieldErrors;
      const message =
        first.email?.[0] ?? first.password?.[0] ?? "Invalid request";
      return res
        .status(400)
        .set(responseTime())
        .json(
          apiError("VALIDATION_ERROR", message, undefined, meta()),
        );
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
        .json(
          apiError(
            "RATE_LIMIT",
            "Too many attempts. Try again in a minute.",
            undefined,
            meta(),
          ),
        );
    }

    // --- Account lookup ---
    const account = await prisma.account
      .findUnique({ where: { email } })
      .catch(() => null);
    if (!account) {
      return res
        .status(401)
        .set(responseTime())
        .json(
          apiError(
            "AUTH_FAILED",
            "Invalid email or password.",
            undefined,
            meta(),
          ),
        );
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
          .json(
            apiError(
              "AUTH_FAILED",
              "Invalid email or password.",
              undefined,
              meta(),
            ),
          );
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
      const mins = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      return res
        .status(423)
        .set(responseTime())
        .json(
          apiError(
            "ACCOUNT_LOCKED",
            `Account temporarily locked. Try again in ${mins} minutes.`,
            undefined,
            meta(),
          ),
        );
    }

    // --- Authenticate against ERPNext ---
    const loginResult = await login(email, password);

    if (!loginResult.ok) {
      const { logger } = await import("../lib/logger.js");
      logger.warn("Login failed", {
        error: loginResult.error,
        request_id: requestId,
      });
      const nextAttempts = (user.failedLoginAttempts ?? 0) + 1;
      const lockedUntil =
        nextAttempts >= 5
          ? new Date(Date.now() + 15 * 60 * 1000)
          : null;
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
        .json(
          apiError(
            "AUTH_FAILED",
            "Invalid email or password.",
            undefined,
            meta(),
          ),
        );
    }

    // --- Reset failed login counter ---
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    // --- Create session ---
    const erpnextSid = loginResult.data;
    const sessionResult = await createSession(
      user.id,
      toWebRequest(req),
      erpnextSid,
    );
    if (!sessionResult.ok) {
      return res
        .status(500)
        .set(responseTime())
        .json(
          apiError(
            "SESSION_ERROR",
            sessionResult.error,
            undefined,
            meta(),
          ),
        );
    }

    const { token, expiresAt } = sessionResult.data;
    const maxAge = Math.max(
      0,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );

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
      .json(
        apiError(
          "SERVER_ERROR",
          "An unexpected error occurred",
          undefined,
          meta(),
        ),
      );
  }
});

// ========================== POST /logout ===================================
router.post("/logout", requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const responseTime = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  const ctx = auditContext(toWebRequest(req));
  const sid = req.cookies?.[COOKIE.SESSION_NAME] ?? undefined;
  if (sid) {
    const sessionResult = await validateSession(
      sid,
      toWebRequest(req),
    );
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
});

// ========================== GET /validate ==================================
router.get("/validate", async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseTime = () => ({ "X-Response-Time": `${Date.now() - start}ms` });
  const ctx = auditContext(toWebRequest(req));

  const token = req.cookies?.[COOKIE.SESSION_NAME] ?? undefined;
  if (!token) {
    return res
      .status(401)
      .set(responseTime())
      .json(
        apiError("UNAUTHORIZED", "Missing session", undefined, meta()),
      );
  }

  const result = await validateSession(
    token,
    toWebRequest(req),
  );
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
      .json(
        apiError("UNAUTHORIZED", result.error, undefined, meta()),
      );
  }

  // Fetch name + email so the sidebar footer can show the real user
  const user = await prisma.user
    .findUnique({
      where: { id: result.data.userId },
      select: { name: true, email: true },
    })
    .catch(() => null);

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
        },
        meta(),
      ),
    );
});

// ========================== POST /forgot-password ==========================
router.post("/forgot-password", requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseTime = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  const bodySchema = z.object({ email: z.string().email() });

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
        .json(
          apiError("INVALID_JSON", "Invalid request body", undefined, meta()),
        );
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return res
        .status(400)
        .set(responseTime())
        .json(
          apiError(
            "VALIDATION_ERROR",
            "Valid email required",
            undefined,
            meta(),
          ),
        );
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
});

// ========================== POST /reset-password ===========================
router.post("/reset-password", requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseTime = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  const bodySchema = z.object({
    token: z.string().min(1),
    password: z.string(),
  });

  try {
    const rateLimit = await checkTieredRateLimit(
      getClientIdentifier(toWebRequest(req)),
      "anonymous",
      "/api/auth/reset-password",
    );
    if (!rateLimit.allowed) {
      return res
        .status(429)
        .set({ ...responseTime(), ...rateLimitHeaders(rateLimit) })
        .json(
          apiError(
            "RATE_LIMIT",
            "Too many attempts. Try again later.",
            undefined,
            meta(),
          ),
        );
    }

    // --- Body validation ---
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res
        .status(400)
        .set(responseTime())
        .json(
          apiError("INVALID_JSON", "Invalid request body", undefined, meta()),
        );
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return res
        .status(400)
        .set(responseTime())
        .json(
          apiError(
            "VALIDATION_ERROR",
            "token and password are required",
            undefined,
            meta(),
          ),
        );
    }

    const { token, password } = parsed.data;
    const pwCheck = validatePassword(password);
    if (!pwCheck.valid) {
      return res
        .status(400)
        .set(responseTime())
        .json(
          apiError(
            "VALIDATION_ERROR",
            pwCheck.errors[0] ?? "Invalid password",
            undefined,
            meta(),
          ),
        );
    }

    const result = await applyPasswordReset({
      raw: token,
      newPassword: password,
    });
    if (!result.ok) {
      return res
        .status(400)
        .set(responseTime())
        .json(
          apiError("RESET_FAILED", result.error, undefined, meta()),
        );
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
      .json(
        apiError(
          "SERVER_ERROR",
          "An unexpected error occurred",
          undefined,
          meta(),
        ),
      );
  }
});

// ========================== POST /change-password ==========================
router.post("/change-password", requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });
  const responseTime = () => ({ "X-Response-Time": `${Date.now() - start}ms` });

  try {
    // --- Session validation ---
    const token = req.cookies?.[COOKIE.SESSION_NAME] ?? undefined;
    if (!token) {
      return res
        .status(401)
        .set(responseTime())
        .json(
          apiError(
            "UNAUTHORIZED",
            "Not authenticated",
            undefined,
            meta(),
          ),
        );
    }
    const session = await validateSession(
      token,
      toWebRequest(req),
    );
    if (!session.ok) {
      return res
        .status(401)
        .set(responseTime())
        .json(
          apiError("UNAUTHORIZED", session.error, undefined, meta()),
        );
    }

    // --- Rate limit (authenticated) ---
    const rateLimit = await checkTieredRateLimit(
      session.data.userId,
      "authenticated",
      "/api/auth/change-password",
    );
    if (!rateLimit.allowed) {
      return res
        .status(429)
        .set({ ...responseTime(), ...rateLimitHeaders(rateLimit) })
        .json(
          apiError(
            "RATE_LIMIT",
            "Too many attempts. Please wait before trying again.",
            undefined,
            meta(),
          ),
        );
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
        .json(
          apiError("VALIDATION", message, undefined, meta()),
        );
    }
    const { currentPassword, newPassword } = bodyParsed.data;

    // --- Validate new password policy ---
    const { valid, errors } = validatePassword(newPassword);
    if (!valid) {
      return res
        .status(400)
        .set(responseTime())
        .json(
          apiError("VALIDATION", errors.join(". "), undefined, meta()),
        );
    }

    // --- Verify current password ---
    const user = await prisma.user.findUnique({
      where: { id: session.data.userId },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!user) {
      return res
        .status(404)
        .set(responseTime())
        .json(
          apiError("NOT_FOUND", "User not found", undefined, meta()),
        );
    }

    const match = await verifyPassword(currentPassword, user.passwordHash ?? "");
    if (!match) {
      return res
        .status(401)
        .set(responseTime())
        .json(
          apiError(
            "UNAUTHORIZED",
            "Current password is incorrect",
            undefined,
            meta(),
          ),
        );
    }

    // --- Update password in ERPNext ---
    const erpUrl = process.env.ERPNEXT_URL ?? "http://localhost:8080";
    const erpApiKey = process.env.ERPNEXT_API_KEY ?? "";
    const erpApiSecret = process.env.ERPNEXT_API_SECRET ?? "";
    const erpRes = await fetch(
      `${erpUrl}/api/method/frappe.core.doctype.user.user.update_password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(erpApiKey && erpApiSecret
            ? { Authorization: `token ${erpApiKey}:${erpApiSecret}` }
            : {}),
        },
        body: JSON.stringify({
          new_password: newPassword,
          logout_all_sessions: 0,
          user: user.email,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    ).catch(() => null);

    // ERPNext unavailable is non-fatal -- still update our DB hash
    if (erpRes && !erpRes.ok) {
      const text = await erpRes.text().catch(() => "");
      Sentry.captureMessage("change-password: ERPNext update failed", {
        extra: { status: erpRes.status, body: text },
      });
    }

    // --- Update hash and revoke all other sessions (keep current only) ---
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const newHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      }),
      prisma.session.deleteMany({
        where: { userId: user.id, token: { not: tokenHash } },
      }),
    ]);

    return res
      .status(200)
      .set(responseTime())
      .json(
        apiSuccess(
          { message: "Password updated successfully" },
          meta(),
        ),
      );
  } catch (err) {
    Sentry.captureException(err);
    return res
      .status(500)
      .set(responseTime())
      .json(
        apiError(
          "INTERNAL",
          "An unexpected error occurred",
          undefined,
          meta(),
        ),
      );
  }
});

export default router;
