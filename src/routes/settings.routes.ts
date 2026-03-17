/**
 * Settings routes — notification preferences and API key management.
 *
 * GET    /settings/notifications     — get notification preferences
 * PUT    /settings/notifications     — update notification preferences
 * GET    /settings/api-keys          — list API keys
 * POST   /settings/api-keys          — create API key
 * DELETE /settings/api-keys/:id      — revoke API key
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { randomBytes, createHash } from "crypto";
import { prisma } from "../lib/data/prisma.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { requireAuth, requirePermission, requireCsrf, toWebRequest } from "../middleware/auth.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";

const router = Router();

// ─── Notification Preferences ───────────────────────────────────────────────

const notifSchema = z.object({
  emailInvoices: z.boolean().optional(),
  emailReports: z.boolean().optional(),
  emailSecurityAlerts: z.boolean().optional(),
  emailProductUpdates: z.boolean().optional(),
});

router.get("/settings/notifications", requireAuth, async (req: Request, res: Response) => {
  const session = req.session!;
  const requestId = getRequestId(toWebRequest(req));

  let prefs = await prisma.notificationPreference.findUnique({
    where: { userId: session.userId },
  });

  if (!prefs) {
    // Return defaults
    prefs = {
      id: "",
      userId: session.userId,
      emailInvoices: true,
      emailReports: true,
      emailSecurityAlerts: true,
      emailProductUpdates: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  return res.json(
    apiSuccess(
      {
        emailInvoices: prefs.emailInvoices,
        emailReports: prefs.emailReports,
        emailSecurityAlerts: prefs.emailSecurityAlerts,
        emailProductUpdates: prefs.emailProductUpdates,
      },
      apiMeta({ request_id: requestId }),
    ),
  );
});

router.put("/settings/notifications", requireAuth, requireCsrf, async (req: Request, res: Response) => {
  const session = req.session!;
  const requestId = getRequestId(toWebRequest(req));

  const parsed = notifSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(apiError("VALIDATION", "Invalid preferences"));
  }

  await prisma.notificationPreference.upsert({
    where: { userId: session.userId },
    update: parsed.data,
    create: { userId: session.userId, ...parsed.data },
  });

  return res.json(apiSuccess({ updated: true }, apiMeta({ request_id: requestId })));
});

// ─── API Keys ───────────────────────────────────────────────────────────────

const apiKeySchema = z.object({
  label: z.string().max(100).optional(),
});

router.get("/settings/api-keys", requireAuth, requirePermission("admin:*"), async (req: Request, res: Response) => {
  const session = req.session!;
  const requestId = getRequestId(toWebRequest(req));

  const keys = await prisma.apiKey.findMany({
    where: { accountId: session.accountId },
    orderBy: { createdAt: "desc" },
    select: { id: true, prefix: true, label: true, lastUsedAt: true, expiresAt: true, createdAt: true },
  });

  return res.json(apiSuccess({ keys }, apiMeta({ request_id: requestId })));
});

router.post(
  "/settings/api-keys",
  requireAuth,
  requireCsrf,
  requirePermission("admin:*"),
  async (req: Request, res: Response) => {
    const session = req.session!;
    const requestId = getRequestId(toWebRequest(req));
    const ctx = auditContext(toWebRequest(req));

    const parsed = apiKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(apiError("VALIDATION", "Invalid request"));
    }

    // Generate API key: wb_live_<random>
    const raw = `wb_live_${randomBytes(24).toString("base64url")}`;
    const prefix = raw.slice(0, 12) + "...";
    const keyHash = createHash("sha256").update(raw).digest("hex");

    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year expiry

    await prisma.apiKey.create({
      data: {
        accountId: session.accountId,
        keyHash,
        prefix,
        label: parsed.data.label ?? null,
        expiresAt,
      },
    });

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "settings.api_key_created",
      meta: { prefix },
      ...ctx,
      severity: "info",
      outcome: "success",
    });

    // Return the full key ONCE — it cannot be retrieved again
    return res.status(201).json(
      apiSuccess(
        {
          key: raw,
          prefix,
          expiresAt,
          label: parsed.data.label ?? null,
          warning: "Store this key securely — it will not be shown again.",
        },
        apiMeta({ request_id: requestId }),
      ),
    );
  },
);

router.delete(
  "/settings/api-keys/:id",
  requireAuth,
  requireCsrf,
  requirePermission("admin:*"),
  async (req: Request, res: Response) => {
    const session = req.session!;
    const requestId = getRequestId(toWebRequest(req));
    const ctx = auditContext(toWebRequest(req));

    const keyId = req.params.id as string;
    const key = await prisma.apiKey.findFirst({
      where: { id: keyId, accountId: session.accountId },
    });

    if (!key) {
      return res.status(404).json(apiError("NOT_FOUND", "API key not found"));
    }

    await prisma.apiKey.delete({ where: { id: key.id } });

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "settings.api_key_revoked",
      meta: { prefix: key.prefix },
      ...ctx,
      severity: "warn",
      outcome: "success",
    });

    return res.json(apiSuccess({ revoked: true }, apiMeta({ request_id: requestId })));
  },
);

export default router;
