/**
 * Webhooks routes
 *
 * POST /webhooks/paddle — Paddle payment webhook handler
 *
 * Paddle sends POST webhooks with a Paddle-Signature header (HMAC-SHA256).
 * We verify the signature, process the event, and return 200.
 *
 * Event types handled:
 *   - transaction.completed — payment succeeded, activate account
 *   - subscription.created — create subscription record
 *   - subscription.updated — plan change
 *   - subscription.canceled — mark subscription as canceled
 */
import express, { Router, Request, Response } from "express";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { verifyPaddleWebhook, markAccountPaid } from "../lib/services/billing.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { toWebRequest } from "../middleware/auth.js";

const router = Router();

const WEBHOOK_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60; // 24 hours

// ---------------------------------------------------------------------------
// Raw body middleware for signature verification
// ---------------------------------------------------------------------------
// Paddle webhook verification requires the raw request body. We capture it
// before JSON parsing so the signature matches the exact bytes Paddle sent.
const rawBodyParser = express.json({
  type: "application/json",
  verify: (req: Request, _res, buf) => {
    (req as Request & { rawBody?: string }).rawBody = buf.toString("utf-8");
  },
});

// ---------------------------------------------------------------------------
// POST /webhooks/paddle — Paddle webhook handler
// ---------------------------------------------------------------------------
router.post("/webhooks/paddle", rawBodyParser, async (req: Request, res: Response) => {
  const start = Date.now();
  const ctx = auditContext(toWebRequest(req));

  const id = getClientIdentifier(toWebRequest(req));
  const rateLimit = await checkTieredRateLimit(id, "anonymous", "/api/webhooks/paddle");
  if (!rateLimit.allowed) {
    const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
    if (systemAccountId) {
      void logAudit({
        accountId: systemAccountId,
        action: "payment.webhook.rate_limited",
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "warn",
        outcome: "failure",
      });
    }
    return res
      .status(429)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .set(rateLimitHeaders(rateLimit) as Record<string, string>)
      .send("Too Many Requests");
  }

  // ── Get raw body and signature ─────────────────────────────────────────
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? "";
  const paddleSignature = (req.headers["paddle-signature"] as string) ?? "";

  // ── Verify HMAC-SHA256 signature ──────────────────────────────────────
  if (!verifyPaddleWebhook(rawBody, paddleSignature)) {
    logger.warn("Paddle webhook: signature verification failed", {
      hasSignature: !!paddleSignature,
    });
    const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
    if (systemAccountId) {
      void logAudit({
        accountId: systemAccountId,
        action: "payment.webhook.invalid_signature",
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "critical",
        outcome: "failure",
      });
    }
    return res.status(401).set("X-Response-Time", `${Date.now() - start}ms`).json({ error: "Invalid signature" });
  }

  // ── Parse event ────────────────────────────────────────────────────────
  const event = req.body as {
    event_type?: string;
    event_id?: string;
    data?: {
      id?: string;
      subscription_id?: string;
      custom_data?: { accountId?: string };
      status?: string;
      items?: Array<{ price?: { id?: string } }>;
    };
  };

  const eventType = event.event_type ?? "";
  const eventId = event.event_id ?? "";

  logger.info("Paddle webhook received", { eventType, eventId });

  // ── Idempotency check ─────────────────────────────────────────────────
  if (eventId) {
    const redis = getRedis();
    if (redis) {
      const idempotencyKey = `webhook:paddle:${eventId}`;
      const set = await redis.set(idempotencyKey, "1", "EX", WEBHOOK_IDEMPOTENCY_TTL_SEC, "NX");
      if (set !== "OK") {
        logger.info("Paddle webhook: duplicate event, skipping", { eventId, eventType });
        return res.status(200).set("X-Response-Time", `${Date.now() - start}ms`).json({ received: true });
      }
    }
  }

  // ── Extract account ID from custom_data ────────────────────────────────
  const accountId = event.data?.custom_data?.accountId ?? "";

  // ── Handle event types ────────────────────────────────────────────────
  switch (eventType) {
    case "transaction.completed": {
      if (!accountId) {
        logger.warn("Paddle webhook: transaction.completed missing accountId", { eventId });
        return res.status(200).set("X-Response-Time", `${Date.now() - start}ms`).json({ received: true });
      }

      const transactionId = event.data?.id ?? "";
      const subscriptionId = event.data?.subscription_id ?? "";
      const result = await markAccountPaid(accountId, transactionId, subscriptionId);

      if (!result.ok) {
        logger.error("Paddle webhook: markAccountPaid error", { error: result.error, accountId, eventId });
      } else {
        void logAudit({
          accountId,
          action: "payment.webhook.success",
          metadata: { transactionId, subscriptionId, eventType },
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "info",
          outcome: "success",
        });
      }
      break;
    }

    case "subscription.created": {
      if (accountId) {
        logger.info("Paddle webhook: subscription.created", {
          accountId,
          subscriptionId: event.data?.id,
          eventId,
        });
        // Subscription creation is handled by markAccountPaid (fires createSubscription).
        // Log for audit trail.
        void logAudit({
          accountId,
          action: "subscription.created",
          metadata: { subscriptionId: event.data?.id, eventId },
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "info",
          outcome: "success",
        });
      }
      break;
    }

    case "subscription.updated": {
      if (accountId) {
        logger.info("Paddle webhook: subscription.updated", {
          accountId,
          subscriptionId: event.data?.id,
          status: event.data?.status,
          eventId,
        });
        void logAudit({
          accountId,
          action: "subscription.updated",
          metadata: {
            subscriptionId: event.data?.id,
            status: event.data?.status,
            eventId,
          },
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "info",
          outcome: "success",
        });
      }
      break;
    }

    case "subscription.canceled": {
      if (accountId) {
        logger.info("Paddle webhook: subscription.canceled", {
          accountId,
          subscriptionId: event.data?.id,
          eventId,
        });

        // Dynamically import to avoid circular deps
        const { cancelSubscription } = await import("../lib/services/subscription.service.js");
        await cancelSubscription(accountId);

        void logAudit({
          accountId,
          action: "subscription.canceled",
          metadata: { subscriptionId: event.data?.id, eventId },
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          severity: "info",
          outcome: "success",
        });
      }
      break;
    }

    default:
      logger.info("Paddle webhook: unhandled event type", { eventType, eventId });
  }

  return res.status(200).set("X-Response-Time", `${Date.now() - start}ms`).json({ received: true });
});

export default router;
