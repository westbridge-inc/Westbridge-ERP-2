/**
 * Webhooks routes
 *
 * GET /webhooks/wipay — WiPay payment callback handler
 *
 * After a customer completes payment on WiPay's hosted payment page,
 * WiPay redirects the customer's browser (GET) back to this endpoint
 * with query params including status, order_id, transaction_id, and hash.
 * We verify the callback, check for success, activate the account,
 * then redirect the browser to the frontend signup result page.
 */
import { Router, Request, Response } from "express";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { verifyPaymentCallback, isPaymentSuccess, markAccountPaid } from "../lib/services/billing.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { toWebRequest } from "../middleware/auth.js";

const router = Router();

const WEBHOOK_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60; // 24 hours

const FRONTEND_URL = () => process.env.FRONTEND_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// GET /webhooks/wipay — WiPay payment callback handler (browser redirect)
// ---------------------------------------------------------------------------
router.get("/webhooks/wipay", async (req: Request, res: Response) => {
  const start = Date.now();
  const ctx = auditContext(toWebRequest(req));

  const id = getClientIdentifier(toWebRequest(req));
  const rateLimit = await checkTieredRateLimit(id, "anonymous", "/api/webhooks/wipay");
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

  // ── Parse callback query params ─────────────────────────────────────────
  const callbackData = {
    status: (req.query.status as string | undefined) ?? "",
    order_id: (req.query.order_id as string | undefined) ?? "",
    transaction_id: (req.query.transaction_id as string | undefined) ?? "",
    hash: (req.query.hash as string | undefined) ?? "",
    reasonDescription: (req.query.reasonDescription as string | undefined) ?? "",
  };

  // ── Verify MD5 hash ────────────────────────────────────────────────────
  // Hash verification is always required in production to prevent spoofed callbacks.
  // In non-production, accept unverified requests for testing convenience.
  if (process.env.NODE_ENV === "production" && !verifyPaymentCallback(callbackData)) {
    logger.warn("WiPay webhook: hash verification failed in production", {
      order_id: callbackData.order_id,
      transaction_id: callbackData.transaction_id,
    });
    const systemAccountId = process.env.SYSTEM_ACCOUNT_ID;
    if (systemAccountId) {
      void logAudit({
        accountId: systemAccountId,
        action: "payment.webhook.invalid_hash",
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        severity: "critical",
        outcome: "failure",
      });
    }
    return res.redirect(`${FRONTEND_URL()}/signup?payment=failed&reason=verification_failed`);
  }

  // ── Check payment success ───────────────────────────────────────────────
  if (!isPaymentSuccess(callbackData)) {
    logger.info("WiPay webhook: payment not approved", {
      status: callbackData.status,
      order_id: callbackData.order_id,
      transaction_id: callbackData.transaction_id,
      reason: callbackData.reasonDescription,
    });
    const reason = encodeURIComponent(callbackData.reasonDescription || "Payment declined");
    return res.redirect(`${FRONTEND_URL()}/signup?payment=failed&reason=${reason}`);
  }

  // ── Idempotency check ──────────────────────────────────────────────────
  const transactionId = callbackData.transaction_id;
  if (transactionId) {
    const redis = getRedis();
    if (redis) {
      const idempotencyKey = `webhook:wipay:${transactionId}`;
      const set = await redis.set(idempotencyKey, "1", "EX", WEBHOOK_IDEMPOTENCY_TTL_SEC, "NX");
      if (set !== "OK") {
        // Already processed — still redirect to success since we already activated
        return res.redirect(`${FRONTEND_URL()}/signup?payment=success`);
      }
    }
  }

  // ── Resolve account ID ────────────────────────────────────────────────
  // The order_id contains the account ID (format: WB-<accountId>-<timestamp>).
  // Also check the accountId query param as fallback (set in response_url).
  let accountId = (req.query.accountId as string | undefined) ?? "";
  if (!accountId && callbackData.order_id) {
    // Parse accountId from order_id format: WB-<accountId>-<timestamp>
    const parts = callbackData.order_id.split("-");
    if (parts.length >= 2) {
      // Rejoin all parts between first and last dash to handle accountIds with dashes
      accountId = parts.slice(1, -1).join("-");
    }
  }

  if (!accountId) {
    logger.warn("WiPay webhook: no account ID found in callback", {
      transactionId,
      order_id: callbackData.order_id,
    });
    return res.redirect(`${FRONTEND_URL()}/signup?payment=failed&reason=missing_account`);
  }

  // ── Activate account ──────────────────────────────────────────────────
  const result = await markAccountPaid(accountId, transactionId);

  if (!result.ok) {
    logger.error("WiPay webhook markAccountPaid error", { error: result.error });
    return res.redirect(`${FRONTEND_URL()}/signup?payment=failed&reason=activation_error`);
  }

  void logAudit({
    accountId,
    action: "payment.webhook.success",
    metadata: {
      transactionId,
      order_id: callbackData.order_id,
      status: callbackData.status,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    severity: "info",
    outcome: "success",
  });

  return res.redirect(`${FRONTEND_URL()}/signup?payment=success`);
});

export default router;
