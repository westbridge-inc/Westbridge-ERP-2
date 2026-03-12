/**
 * Webhooks routes
 *
 * POST /webhooks/2checkout — 2Checkout IPN webhook handler
 */
import { Router, Request, Response } from "express";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import {
  verifyIPN,
  isPaymentSuccess,
  markAccountPaid,
} from "../lib/services/billing.service.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { matchesCidr } from "../lib/ip-utils.js";
import type { CidrRange } from "../lib/ip-utils.js";
import { toWebRequest } from "../middleware/auth.js";

const router = Router();

const WEBHOOK_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60; // 24 hours

/** Safelist of known 2Checkout IPN parameter names to prevent property injection. */
const ALLOWED_IPN_PARAMS = new Set([
  "MERCHANT_ORDER_ID", "EXTERNAL_REFERENCE", "REFNO", "ORDERNO", "ORDER_NUMBER",
  "TOTAL", "ORDER_TOTAL", "STATUS", "ORDER_STATUS", "MESSAGE_TYPE",
  "MD5_HASH", "HMAC", "CUSTOMER_REF", "MERCHANT_SID",
  "IPN_PID", "IPN_PNAME", "IPN_DATE", "IPN_TOTALGENERAL",
  "FIRSTNAME", "LASTNAME", "EMAIL", "PHONE",
]);

/** 2Checkout IPN source IP ranges (CIDR notation). */
const TWOCHECKOUT_CIDRS: CidrRange[] = [
  { network: "86.105.46.0", prefix: 24 },
  { network: "195.65.26.0", prefix: 24 },
  { network: "195.242.0.0", prefix: 16 },
];

function is2CheckoutIP(ip: string): boolean {
  return matchesCidr(ip, TWOCHECKOUT_CIDRS);
}

// ---------------------------------------------------------------------------
// POST /webhooks/2checkout — 2Checkout IPN webhook handler
// ---------------------------------------------------------------------------
router.post("/webhooks/2checkout", async (req: Request, res: Response) => {
  const start = Date.now();
  const ctx = auditContext(toWebRequest(req));
  const clientIP = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? (req.headers["x-real-ip"] as string) ?? "";
  if (clientIP && !is2CheckoutIP(clientIP)) {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).set("X-Response-Time", `${Date.now() - start}ms`).send("Forbidden");
    }
    logger.warn("2Checkout webhook from non-allowlisted IP (non-production)", { ip: clientIP });
  }
  const id = getClientIdentifier(toWebRequest(req));
  const rateLimit = await checkTieredRateLimit(id, "anonymous", "/api/webhooks/2checkout");
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

  let paramsRecord: Record<string, string | undefined> = {};
  const contentType = req.headers["content-type"] ?? "";
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      // Express with urlencoded parser will have already parsed req.body
      paramsRecord = req.body as Record<string, string | undefined>;
    } else {
      // Handle form-data (multer or similar middleware should be used upstream)
      // Fallback: try to use body as-is
      if (req.body && typeof req.body === "object") {
        const entries = Object.entries(req.body);
        for (const [key, value] of entries) {
          // Only allow known 2Checkout IPN parameters to prevent property injection
          if (ALLOWED_IPN_PARAMS.has(key)) {
            paramsRecord[key] = typeof value === "string" ? value : undefined;
          }
        }
      }
    }
  } catch {
    return res.status(400).set("X-Response-Time", `${Date.now() - start}ms`).send("Bad Request");
  }

  if (!verifyIPN(paramsRecord)) {
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
    return res.status(401).set("X-Response-Time", `${Date.now() - start}ms`).send("Invalid signature");
  }

  if (!isPaymentSuccess(paramsRecord)) {
    return res.status(200).set("X-Response-Time", `${Date.now() - start}ms`).send("OK");
  }

  const refno = paramsRecord.REFNO ?? paramsRecord.ORDERNO ?? paramsRecord.ORDER_NUMBER ?? "";
  if (refno) {
    const redis = getRedis();
    if (redis) {
      const idempotencyKey = `webhook:2co:${refno}`;
      const set = await redis.set(idempotencyKey, "1", "EX", WEBHOOK_IDEMPOTENCY_TTL_SEC, "NX");
      if (set !== "OK") {
        return res.status(200).set("X-Response-Time", `${Date.now() - start}ms`).send("OK");
      }
    }
  }

  const accountId = paramsRecord.MERCHANT_ORDER_ID ?? paramsRecord.EXTERNAL_REFERENCE ?? paramsRecord.REFNO;
  if (!accountId) {
    return res.status(200).set("X-Response-Time", `${Date.now() - start}ms`).send("OK");
  }

  const result = await markAccountPaid(
    accountId,
    paramsRecord.ORDERNO ?? paramsRecord.ORDER_NUMBER,
    paramsRecord.CUSTOMER_REF
  );

  if (!result.ok) {
    logger.error("2Checkout webhook markAccountPaid error", { error: result.error });
    return res.status(500).set("X-Response-Time", `${Date.now() - start}ms`).send("Error");
  }

  void logAudit({
    accountId,
    action: "payment.webhook.success",
    metadata: {
      orderNo: paramsRecord.ORDERNO ?? paramsRecord.ORDER_NUMBER,
      customerRef: paramsRecord.CUSTOMER_REF,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    severity: "info",
    outcome: "success",
  });

  return res.status(200).set("X-Response-Time", `${Date.now() - start}ms`).send("OK");
});

export default router;
