/**
 * Webhooks routes
 *
 * POST /webhooks/powertranz — PowerTranz payment callback handler
 *
 * After a customer completes payment on PowerTranz's hosted payment page,
 * PowerTranz POSTs the result back to this endpoint. We verify the callback,
 * check for success, and activate the account.
 */
import { Router, Request, Response } from "express";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { verifyPaymentCallback, isPaymentSuccess, markAccountPaid } from "../lib/services/billing.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { matchesCidr, type CidrRange } from "../lib/ip-utils.js";
import { toWebRequest } from "../middleware/auth.js";

const router = Router();

const WEBHOOK_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60; // 24 hours

/**
 * Safelist of known PowerTranz callback parameter names to prevent injection.
 * PowerTranz sends JSON with PascalCase keys.
 */
const ALLOWED_CALLBACK_PARAMS = new Set([
  "SpiToken",
  "TransactionIdentifier",
  "OrderIdentifier",
  "Approved",
  "ResponseCode",
  "ResponseMessage",
  "RRN",
  "IsoResponseCode",
  "TotalAmount",
  "CurrencyCode",
  "CardBrand",
  "MaskedPan",
  "AuthorizationCode",
  "ExternalIdentifier",
  "Errors",
]);

/**
 * PowerTranz source IP ranges (CIDR notation).
 * Staging (staging.ptranz.com) and production (ptranz.com) ranges.
 * These should be verified and updated from PowerTranz documentation.
 */
const POWERTRANZ_CIDRS: CidrRange[] = [
  // PowerTranz production and staging ranges — update from gateway documentation
  { network: "204.191.136.0", prefix: 24 },
  { network: "204.191.137.0", prefix: 24 },
];

function isPowerTranzIP(ip: string): boolean {
  // In non-production, allow all IPs for testing
  if (process.env.NODE_ENV !== "production") return true;
  return matchesCidr(ip, POWERTRANZ_CIDRS);
}

// ---------------------------------------------------------------------------
// POST /webhooks/powertranz — PowerTranz payment callback handler
// ---------------------------------------------------------------------------
router.post("/webhooks/powertranz", async (req: Request, res: Response) => {
  const start = Date.now();
  const ctx = auditContext(toWebRequest(req));
  const clientIP =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? (req.headers["x-real-ip"] as string) ?? "";

  if (clientIP && !isPowerTranzIP(clientIP)) {
    logger.warn("PowerTranz webhook from non-allowlisted IP", { ip: clientIP });
    return res
      .status(403)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .send("Forbidden");
  }

  const id = getClientIdentifier(toWebRequest(req));
  const rateLimit = await checkTieredRateLimit(id, "anonymous", "/api/webhooks/powertranz");
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

  // ── Parse callback data ─────────────────────────────────────────────────
  const callbackData: Record<string, unknown> = {};
  try {
    if (req.body && typeof req.body === "object") {
      // Filter to allowed parameters only
      for (const [key, value] of Object.entries(req.body)) {
        if (ALLOWED_CALLBACK_PARAMS.has(key)) {
          callbackData[key] = value;
        }
      }
    }
  } catch {
    return res
      .status(400)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .send("Bad Request");
  }

  // ── Verify signature (if PowerTranz sends one) ──────────────────────────
  const signature = req.headers["x-powertranz-signature"] as string | undefined;
  if (signature) {
    // Use the raw body for signature verification
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (!verifyPaymentCallback(rawBody, signature)) {
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
      return res
        .status(401)
        .set("X-Response-Time", `${Date.now() - start}ms`)
        .send("Invalid signature");
    }
  }

  // ── Check payment success ───────────────────────────────────────────────
  const paymentData = {
    SpiToken: callbackData.SpiToken as string | undefined,
    TransactionIdentifier: callbackData.TransactionIdentifier as string | undefined,
    OrderIdentifier: callbackData.OrderIdentifier as string | undefined,
    Approved: callbackData.Approved as boolean | undefined,
    ResponseCode: callbackData.ResponseCode as string | undefined,
    ResponseMessage: callbackData.ResponseMessage as string | undefined,
    RRN: callbackData.RRN as string | undefined,
    IsoResponseCode: callbackData.IsoResponseCode as string | undefined,
    TotalAmount: callbackData.TotalAmount as number | undefined,
    CurrencyCode: callbackData.CurrencyCode as string | undefined,
  };

  if (!isPaymentSuccess(paymentData)) {
    logger.info("PowerTranz webhook: payment not approved", {
      responseCode: paymentData.ResponseCode,
      responseMessage: paymentData.ResponseMessage,
      transactionId: paymentData.TransactionIdentifier,
    });
    return res
      .status(200)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .send("OK");
  }

  // ── Idempotency check ──────────────────────────────────────────────────
  const transactionId = paymentData.TransactionIdentifier ?? "";
  if (transactionId) {
    const redis = getRedis();
    if (redis) {
      const idempotencyKey = `webhook:ptz:${transactionId}`;
      const set = await redis.set(idempotencyKey, "1", "EX", WEBHOOK_IDEMPOTENCY_TTL_SEC, "NX");
      if (set !== "OK") {
        return res
          .status(200)
          .set("X-Response-Time", `${Date.now() - start}ms`)
          .send("OK");
      }
    }
  }

  // ── Resolve account ID ────────────────────────────────────────────────
  // OrderIdentifier contains the account ID we passed when creating the session.
  // Also check query param as fallback (set in MerchantResponseUrl).
  const accountId = paymentData.OrderIdentifier ?? (req.query.accountId as string | undefined) ?? "";
  if (!accountId) {
    logger.warn("PowerTranz webhook: no account ID found in callback", {
      transactionId,
      orderIdentifier: paymentData.OrderIdentifier,
    });
    return res
      .status(200)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .send("OK");
  }

  // ── Activate account ──────────────────────────────────────────────────
  const result = await markAccountPaid(accountId, transactionId, paymentData.RRN);

  if (!result.ok) {
    logger.error("PowerTranz webhook markAccountPaid error", { error: result.error });
    return res
      .status(500)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .send("Error");
  }

  void logAudit({
    accountId,
    action: "payment.webhook.success",
    metadata: {
      transactionId,
      rrn: paymentData.RRN,
      responseCode: paymentData.ResponseCode,
      amount: paymentData.TotalAmount,
      currency: paymentData.CurrencyCode,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    severity: "info",
    outcome: "success",
  });

  return res
    .status(200)
    .set("X-Response-Time", `${Date.now() - start}ms`)
    .send("OK");
});

export default router;
