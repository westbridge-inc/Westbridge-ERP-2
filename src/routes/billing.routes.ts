/**
 * Billing routes
 *
 * GET    /billing/history     — billing invoice history
 * GET    /billing/subscription — current subscription details
 * POST   /billing/change-plan  — upgrade/downgrade plan
 * POST   /billing/cancel       — cancel subscription
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { prisma } from "../lib/data/prisma.js";
import { apiSuccess, apiError, apiMeta, getRequestId } from "../types/api.js";
import { requireAuth, requirePermission, requireCsrf, toWebRequest } from "../middleware/auth.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { changePlan, cancelSubscription } from "../lib/services/subscription.service.js";

const router = Router();

// ─── GET /billing/history ───────────────────────────────────────────────────

router.get("/billing/history", requireAuth, requirePermission("billing:read"), async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const session = req.session!;

    const [account, invoices] = await Promise.all([
      prisma.account.findUnique({
        where: { id: session.accountId },
        select: { plan: true, status: true, createdAt: true },
      }),
      prisma.billingInvoice.findMany({
        where: { accountId: session.accountId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);

    return res
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .json(
        apiSuccess(
          {
            items: invoices.map((inv) => ({
              id: inv.id,
              amount: inv.amount,
              currency: inv.currency,
              status: inv.status,
              plan: inv.planId,
              periodStart: inv.periodStart,
              periodEnd: inv.periodEnd,
              paidAt: inv.paidAt,
              transactionId: inv.transactionId,
              createdAt: inv.createdAt,
            })),
            plan: account?.plan ?? null,
            status: account?.status ?? null,
            accountCreatedAt: account?.createdAt ?? null,
          },
          meta(),
        ),
      );
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "Unable to load billing history right now. Please try again.", undefined, meta()));
  }
});

// ─── GET /billing/subscription ──────────────────────────────────────────────

router.get("/billing/subscription", requireAuth, requirePermission("billing:read"), async (req: Request, res: Response) => {
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const session = req.session!;

    const subscription = await prisma.subscription.findFirst({
      where: { accountId: session.accountId },
      orderBy: { createdAt: "desc" },
    });

    if (!subscription) {
      return res.json(apiSuccess({ subscription: null }, meta()));
    }

    return res.json(
      apiSuccess(
        {
          subscription: {
            id: subscription.id,
            planId: subscription.planId,
            status: subscription.status,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
          },
        },
        meta(),
      ),
    );
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "Unable to load subscription details right now. Please try again.", undefined, meta()));
  }
});

// ─── POST /billing/change-plan ──────────────────────────────────────────────

const changePlanSchema = z.object({
  planId: z.enum(["Starter", "Business", "Enterprise"]),
});

router.post("/billing/change-plan", requireAuth, requireCsrf, requirePermission("billing:manage"), async (req: Request, res: Response) => {
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    const parsed = changePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(apiError("VALIDATION", "Valid planId required", undefined, meta()));
    }

    const result = await changePlan(session.accountId, parsed.data.planId);
    if (!result.ok) {
      const safeMessages = ["Invalid plan", "Unable to change your plan right now. Please try again or contact support."];
      const message = safeMessages.includes(result.error) ? result.error : "Unable to change your plan right now. Please try again.";
      return res.status(400).json(apiError("BILLING_ERROR", message, undefined, meta()));
    }

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "billing.plan_changed",
      meta: { newPlan: parsed.data.planId },
      ...ctx,
      severity: "info",
      outcome: "success",
    });

    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred. Please try again.", undefined, meta()));
  }
});

// ─── POST /billing/cancel ───────────────────────────────────────────────────

router.post("/billing/cancel", requireAuth, requireCsrf, requirePermission("billing:manage"), async (req: Request, res: Response) => {
  const requestId = getRequestId(toWebRequest(req));
  const meta = () => apiMeta({ request_id: requestId });

  try {
    const session = req.session!;
    const ctx = auditContext(toWebRequest(req));

    const result = await cancelSubscription(session.accountId);
    if (!result.ok) {
      return res.status(500).json(apiError("BILLING_ERROR", "Unable to cancel your subscription right now. Please try again or contact support.", undefined, meta()));
    }

    void logAudit({
      accountId: session.accountId,
      userId: session.userId,
      action: "billing.subscription_canceled",
      ...ctx,
      severity: "warn",
      outcome: "success",
    });

    return res.json(apiSuccess(result.data, meta()));
  } catch (error) {
    Sentry.captureException(error, { extra: { request_id: requestId } });
    return res.status(500).json(apiError("SERVER_ERROR", "An unexpected error occurred. Please try again.", undefined, meta()));
  }
});

export default router;
