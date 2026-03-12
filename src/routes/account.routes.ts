/**
 * Account routes
 *
 * PATCH  /account/profile — update the current user's profile (name)
 * DELETE /account/delete  — GDPR right-to-deletion (owner only)
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { validateSession, revokeAllUserSessions } from "../lib/services/session.service.js";
import { checkTieredRateLimit, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { prisma } from "../lib/data/prisma.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { COOKIE } from "../lib/constants.js";
import { toWebRequest, requireCsrf } from "../middleware/auth.js";
import * as Sentry from "@sentry/node";

const router = Router();

const profileSchema = z.object({
  name: z.string().min(1).max(120).trim(),
});

// ---------------------------------------------------------------------------
// PATCH /account/profile — update the current user's profile (name)
// ---------------------------------------------------------------------------
router.patch("/account/profile", requireCsrf, async (req: Request, res: Response) => {
  const requestId = getRequestId(toWebRequest(req));
  const meta = { request_id: requestId };

  // Session validation
  const token = req.cookies?.[COOKIE.SESSION_NAME];
  if (!token) {
    return res.status(401).json(apiError("UNAUTHORIZED", "Authentication required", undefined, meta));
  }
  const sessionResult = await validateSession(token, toWebRequest(req));
  if (!sessionResult.ok) {
    return res.status(401).json(apiError("UNAUTHORIZED", "Authentication required", undefined, meta));
  }
  const session = sessionResult.data;

  const rateLimit = await checkTieredRateLimit(session.userId, "authenticated", "/api/account/profile");
  if (!rateLimit.allowed) {
    return res
      .status(429)
      .set(rateLimitHeaders(rateLimit) as Record<string, string>)
      .json(
        apiError("RATE_LIMITED", "Too many requests. Please try again shortly.", undefined, meta)
      );
  }

  // Parse and validate body
  const body = req.body;
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json(
      apiError("INVALID_REQUEST", "Name is required and must be under 120 characters.", undefined, meta)
    );
  }

  const { name } = parsed.data;

  await prisma.user.update({
    where: { id: session.userId },
    data: { name },
  });

  return res.json(apiSuccess({ name }, meta));
});

// ---------------------------------------------------------------------------
// GET /account/export — GDPR right to data portability (Article 20)
// ---------------------------------------------------------------------------
router.post("/account/export", requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const token = req.cookies?.[COOKIE.SESSION_NAME];
    if (!token) {
      return res.status(401).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("UNAUTHORIZED", "Authentication required", undefined, meta()));
    }
    const sessionResult = await validateSession(token, toWebRequest(req));
    if (!sessionResult.ok) {
      return res.status(401).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("UNAUTHORIZED", "Authentication required", undefined, meta()));
    }
    const session = sessionResult.data;

    if (session.role !== "owner" && session.role !== "admin") {
      return res.status(403).set("X-Response-Time", `${Date.now() - start}ms`).json(
        apiError("FORBIDDEN", "Only account owner or admin can export account data", undefined, meta())
      );
    }

    const rateLimit = await checkTieredRateLimit(session.userId, "authenticated", "/api/account/export");
    if (!rateLimit.allowed) {
      return res
        .status(429)
        .set("X-Response-Time", `${Date.now() - start}ms`)
        .set(rateLimitHeaders(rateLimit) as Record<string, string>)
        .json(apiError("RATE_LIMIT", "Export rate limit: 3 per hour. Try again later.", undefined, meta()));
    }

    const ctx = auditContext(toWebRequest(req));

    // Gather all account data in a portable format
    const [account, users, auditLogs, subscriptions, apiKeys, webhooks, invites] = await Promise.all([
      prisma.account.findUnique({
        where: { id: session.accountId },
        select: {
          id: true, email: true, companyName: true, plan: true,
          status: true, erpnextCompany: true, modulesSelected: true,
          createdAt: true, updatedAt: true,
        },
      }),
      prisma.user.findMany({
        where: { accountId: session.accountId },
        select: {
          id: true, name: true, email: true, role: true,
          status: true, createdAt: true, updatedAt: true,
        },
      }),
      prisma.auditLog.findMany({
        where: { accountId: session.accountId },
        orderBy: { timestamp: "desc" },
        take: 10_000,
        select: {
          id: true, action: true, resource: true, resourceId: true,
          userId: true, severity: true, outcome: true, timestamp: true,
        },
      }),
      prisma.subscription.findMany({
        where: { accountId: session.accountId },
        select: {
          id: true, planId: true, status: true, currentPeriodStart: true,
          currentPeriodEnd: true, createdAt: true,
        },
      }),
      prisma.apiKey.findMany({
        where: { accountId: session.accountId },
        select: {
          id: true, prefix: true, label: true, createdAt: true,
          lastUsedAt: true, expiresAt: true,
        },
      }),
      prisma.webhookEndpoint.findMany({
        where: { accountId: session.accountId },
        select: {
          id: true, url: true, events: true, enabled: true,
          createdAt: true,
        },
      }),
      prisma.inviteToken.findMany({
        where: { accountId: session.accountId },
        select: {
          id: true, email: true, role: true, usedAt: true,
          createdAt: true, expiresAt: true,
        },
      }),
    ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      exportVersion: "1.0",
      account,
      users,
      subscriptions,
      apiKeys,
      webhooks,
      invites,
      auditLogs: {
        count: auditLogs.length,
        note: auditLogs.length >= 10_000 ? "Truncated to most recent 10,000 entries" : undefined,
        entries: auditLogs,
      },
    };

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "account.data_exported",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });

    const filename = `westbridge-export-${session.accountId}-${new Date().toISOString().slice(0, 10)}.json`;
    return res
      .set("Content-Type", "application/json")
      .set("Content-Disposition", `attachment; filename="${filename}"`)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .json(exportData);
  } catch (err) {
    Sentry.captureException(err);
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(
      apiError("INTERNAL", "An unexpected error occurred", undefined, meta())
    );
  }
});

// ---------------------------------------------------------------------------
// DELETE /account/delete — GDPR right-to-deletion (owner only)
// ---------------------------------------------------------------------------
router.delete("/account/delete", requireCsrf, async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const token = req.cookies?.[COOKIE.SESSION_NAME];
    if (!token) {
      return res.status(401).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("UNAUTHORIZED", "Not authenticated", undefined, meta()));
    }
    const sessionResult = await validateSession(token, toWebRequest(req));
    if (!sessionResult.ok) {
      return res.status(401).set("X-Response-Time", `${Date.now() - start}ms`).json(apiError("UNAUTHORIZED", sessionResult.error, undefined, meta()));
    }
    const session = sessionResult.data;

    if (session.role !== "owner") {
      return res.status(403).set("X-Response-Time", `${Date.now() - start}ms`).json(
        apiError("FORBIDDEN", "Only the account owner can delete the account", undefined, meta())
      );
    }

    const rateLimit = await checkTieredRateLimit(session.userId, "authenticated", "/api/account/delete");
    if (!rateLimit.allowed) {
      return res
        .status(429)
        .set("X-Response-Time", `${Date.now() - start}ms`)
        .set(rateLimitHeaders(rateLimit) as Record<string, string>)
        .json(
          apiError("RATE_LIMIT", "Too many attempts. Please wait before trying again.", undefined, meta())
        );
    }

    const ctx = auditContext(toWebRequest(req));

    // Collect user IDs before the transaction so we can invalidate Redis sessions after.
    const usersToDelete = await prisma.user.findMany({
      where: { accountId: session.accountId },
      select: { id: true },
    });
    const userIds = usersToDelete.map((u) => u.id);

    await prisma.$transaction(async (tx) => {
      for (const u of usersToDelete) {
        await tx.user.update({
          where: { id: u.id },
          data: {
            name: "Deleted User",
            email: `deleted-${u.id}@deleted.invalid`,
            status: "deleted",
          },
        });
      }

      await tx.session.deleteMany({ where: { userId: { in: userIds } } });
      await tx.inviteToken.deleteMany({ where: { accountId: session.accountId } });
      await tx.account.update({
        where: { id: session.accountId },
        data: { status: "deleted" },
      });
    });

    // Invalidate all Redis session caches for every user in the deleted account.
    // DB sessions were already deleted in the transaction above; this flushes
    // the Redis cache so revoked sessions cannot authenticate during the cache TTL.
    await Promise.all(
      userIds.map((uid) => revokeAllUserSessions(uid).catch(() => {}))
    );

    await logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "account.deleted",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      severity: "info",
      outcome: "success",
    });

    return res.set("X-Response-Time", `${Date.now() - start}ms`).json(apiSuccess({ message: "Account deleted" }, meta()));
  } catch (err) {
    Sentry.captureException(err);
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).json(
      apiError("INTERNAL", "An unexpected error occurred", undefined, meta())
    );
  }
});

export default router;
