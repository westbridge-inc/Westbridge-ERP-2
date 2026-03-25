/**
 * Webhooks routes
 *
 * POST /webhooks/payment  -- 2Checkout IPN (Instant Payment Notification) handler
 * POST /webhooks/erpnext  -- ERPNext document change webhook
 *
 * After a customer completes payment on 2Checkout's hosted checkout page,
 * 2Checkout sends an IPN (form-urlencoded POST) to this endpoint. We verify
 * the HMAC-MD5 signature, check for success, and activate the account.
 */
import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { checkTieredRateLimit, getClientIdentifier, rateLimitHeaders } from "../lib/api/rate-limit-tiers.js";
import { verifyPaymentCallback, isPaymentSuccess, markAccountPaid } from "../lib/services/billing.service.js";
import { generateIpnResponse, type PaymentCallbackData } from "../lib/data/twocheckout.client.js";
import { logAudit, auditContext } from "../lib/services/audit.service.js";
import { getRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { matchesCidr, type CidrRange } from "../lib/ip-utils.js";
import { toWebRequest } from "../middleware/auth.js";
import { publish } from "../lib/realtime.js";
import { PLAN_AMOUNTS } from "../lib/constants.js";
import { prisma } from "../lib/data/prisma.js";
import { ALLOWED_DOCTYPES_SET } from "../lib/erp-constants.js";

const router = Router();

const WEBHOOK_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60; // 24 hours

/**
 * Safelist of known 2Checkout IPN parameter names to prevent injection.
 * 2Checkout sends form-urlencoded data with UPPER_CASE keys.
 */
const ALLOWED_IPN_PARAMS = new Set([
  "REFNO",
  "ORDERNO",
  "REFNOEXT",
  "IPN_PID",
  "IPN_PNAME",
  "IPN_PRICE",
  "IPN_QTY",
  "IPN_DATE",
  "ORDERSTATUS",
  "PAYMETHOD",
  "CURRENCY",
  "HASH",
  "FRAUD_STATUS",
  "IPN_TOTALGENERAL",
  "IPN_FIRSTNAME",
  "IPN_LASTNAME",
]);

/**
 * 2Checkout source IP ranges (CIDR notation).
 * These should be verified and updated from 2Checkout/Verifone documentation.
 */
const TWOCHECKOUT_CIDRS: CidrRange[] = [
  // 2Checkout IPN source ranges -- update from Verifone documentation
  { network: "5.249.160.0", prefix: 21 },
  { network: "185.109.252.0", prefix: 22 },
];

function isTwoCheckoutIP(ip: string): boolean {
  // In non-production, allow all IPs for testing
  if (process.env.NODE_ENV !== "production") return true;
  return matchesCidr(ip, TWOCHECKOUT_CIDRS);
}

// ---------------------------------------------------------------------------
// POST /webhooks/payment -- 2Checkout IPN handler
// ---------------------------------------------------------------------------
router.post("/webhooks/payment", async (req: Request, res: Response) => {
  const start = Date.now();
  const ctx = auditContext(toWebRequest(req));
  const clientIP =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? (req.headers["x-real-ip"] as string) ?? "";

  if (clientIP && !isTwoCheckoutIP(clientIP)) {
    logger.warn("2Checkout webhook from non-allowlisted IP", { ip: clientIP });
    return res
      .status(403)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .send("Forbidden");
  }

  const id = getClientIdentifier(toWebRequest(req));
  const rateLimit = await checkTieredRateLimit(id, "anonymous", "/api/webhooks/payment");
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

  // ── Parse IPN callback data (form-urlencoded) ──────────────────────────
  const callbackData: Record<string, unknown> = {};
  try {
    if (req.body && typeof req.body === "object") {
      // Filter to allowed IPN parameters only
      for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) {
        if (ALLOWED_IPN_PARAMS.has(key)) {
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

  // ── Verify HMAC-MD5 signature ──────────────────────────────────────────
  // 2Checkout IPN includes a HASH field computed with HMAC-MD5.
  // Signature is always required in production to prevent spoofed callbacks.
  const ipnHash = callbackData.HASH as string | undefined;
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const parsedData = callbackData as PaymentCallbackData;

  if (process.env.NODE_ENV === "production" && !ipnHash) {
    logger.warn("2Checkout webhook: missing HASH in production", { ip: clientIP });
    return res
      .status(401)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .send("Missing signature");
  }

  if (ipnHash && !verifyPaymentCallback(rawBody, ipnHash, parsedData)) {
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

  // ── Check payment success ─────────────────────────────────────────────
  if (!isPaymentSuccess(parsedData)) {
    logger.info("2Checkout webhook: payment not approved", {
      orderStatus: parsedData.ORDERSTATUS,
      refno: parsedData.REFNO,
    });
    // Still respond with IPN confirmation so 2CO stops retrying
    const ipnDate = (parsedData.IPN_DATE as string) ?? new Date().toISOString();
    return res
      .status(200)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .set("Content-Type", "text/xml")
      .send(generateIpnResponse(ipnDate));
  }

  // ── Idempotency check ─────────────────────────────────────────────────
  const refno = (parsedData.REFNO as string) ?? "";
  if (refno) {
    const redis = getRedis();
    if (redis) {
      const idempotencyKey = `webhook:2co:${refno}`;
      const set = await redis.set(idempotencyKey, "1", "EX", WEBHOOK_IDEMPOTENCY_TTL_SEC, "NX");
      if (set !== "OK") {
        const ipnDate = (parsedData.IPN_DATE as string) ?? new Date().toISOString();
        return res
          .status(200)
          .set("X-Response-Time", `${Date.now() - start}ms`)
          .set("Content-Type", "text/xml")
          .send(generateIpnResponse(ipnDate));
      }
    }
  }

  // ── Resolve account ID ────────────────────────────────────────────────
  // REFNOEXT contains the account ID we passed as order-ext-ref in the buy link.
  const accountId = (parsedData.REFNOEXT as string) ?? "";
  if (!accountId) {
    logger.warn("2Checkout webhook: no account ID found in IPN", {
      refno,
      refnoext: parsedData.REFNOEXT,
    });
    const ipnDate = (parsedData.IPN_DATE as string) ?? new Date().toISOString();
    return res
      .status(200)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .set("Content-Type", "text/xml")
      .send(generateIpnResponse(ipnDate));
  }

  // ── Verify account exists and is pending payment ───────────────────
  // Prevents forged IPNs from activating arbitrary accounts.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, status: true, plan: true },
  });

  if (!account) {
    logger.warn("2Checkout webhook: account not found", { accountId, refno });
    const ipnDate = (parsedData.IPN_DATE as string) ?? new Date().toISOString();
    return res
      .status(200)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .set("Content-Type", "text/xml")
      .send(generateIpnResponse(ipnDate));
  }

  // Only activate accounts that are pending or renewing — block replays against already-active accounts
  if (account.status !== "pending" && account.status !== "active") {
    logger.warn("2Checkout webhook: account not in activatable state", {
      accountId,
      status: account.status,
      refno,
    });
    const ipnDate = (parsedData.IPN_DATE as string) ?? new Date().toISOString();
    return res
      .status(200)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .set("Content-Type", "text/xml")
      .send(generateIpnResponse(ipnDate));
  }

  // Verify the payment amount matches the plan price (within tolerance for currency conversion)
  const expectedAmount = PLAN_AMOUNTS[account.plan] ?? 0;
  const receivedAmount = parseFloat((parsedData.IPN_TOTALGENERAL as string) ?? "0");
  if (expectedAmount > 0 && Math.abs(receivedAmount - expectedAmount) > 1.0) {
    logger.error("2Checkout webhook: amount mismatch", {
      accountId,
      expected: expectedAmount,
      received: receivedAmount,
      plan: account.plan,
      refno,
    });
    const ipnDate = (parsedData.IPN_DATE as string) ?? new Date().toISOString();
    return res
      .status(200)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .set("Content-Type", "text/xml")
      .send(generateIpnResponse(ipnDate));
  }

  // ── Activate account ──────────────────────────────────────────────────
  const result = await markAccountPaid(accountId, refno, undefined);

  if (!result.ok) {
    logger.error("2Checkout webhook markAccountPaid error", { error: result.error });
    return res
      .status(500)
      .set("X-Response-Time", `${Date.now() - start}ms`)
      .send("Error");
  }

  void logAudit({
    accountId,
    action: "payment.webhook.success",
    metadata: {
      refno,
      orderStatus: parsedData.ORDERSTATUS,
      amount: parsedData.IPN_TOTALGENERAL,
      currency: parsedData.CURRENCY,
      ipnDate: parsedData.IPN_DATE,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    severity: "info",
    outcome: "success",
  });

  // ── Respond with IPN confirmation (required by 2Checkout) ─────────────
  const ipnDate = (parsedData.IPN_DATE as string) ?? new Date().toISOString();
  return res
    .status(200)
    .set("X-Response-Time", `${Date.now() - start}ms`)
    .set("Content-Type", "text/xml")
    .send(generateIpnResponse(ipnDate));
});

// ---------------------------------------------------------------------------
// POST /webhooks/erpnext -- ERPNext document change webhook
// ---------------------------------------------------------------------------
// Configure ERPNext to POST to this URL when documents are created, updated,
// submitted, or cancelled. Verifies via shared secret (ERPNEXT_WEBHOOK_SECRET).
// Publishes real-time events to connected Westbridge clients.
// ---------------------------------------------------------------------------

const erpnextWebhookSchema = z.object({
  event: z.string(), // e.g. "on_update", "on_submit", "on_cancel", "after_insert"
  doctype: z.string(),
  name: z.string(),
  data: z.record(z.unknown()).optional(),
});

router.post("/webhooks/erpnext", async (req: Request, res: Response) => {
  const start = Date.now();
  const responseTime = () => res.set("X-Response-Time", `${Date.now() - start}ms`);

  // Rate limit
  const id = getClientIdentifier(toWebRequest(req));
  const rl = await checkTieredRateLimit(id, "anonymous", "/api/webhooks/erpnext");
  if (!rl.allowed) {
    return responseTime()
      .status(429)
      .set(rateLimitHeaders(rl) as Record<string, string>)
      .send("Too Many Requests");
  }

  // Verify shared secret via HMAC
  const secret = process.env.ERPNEXT_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers["x-erpnext-signature"] as string | undefined;
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      logger.warn("ERPNext webhook: invalid signature");
      return responseTime().status(401).send("Invalid signature");
    }
  } else if (process.env.NODE_ENV === "production") {
    logger.warn("ERPNext webhook: ERPNEXT_WEBHOOK_SECRET not set in production");
    return responseTime().status(500).send("Webhook secret not configured");
  }

  // Parse payload
  const parsed = erpnextWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return responseTime().status(400).send("Invalid payload");
  }

  const { event, doctype, name, data } = parsed.data;

  // Only process allowed doctypes
  if (!ALLOWED_DOCTYPES_SET.has(doctype)) {
    return responseTime().status(200).send("OK");
  }

  logger.info("ERPNext webhook received", { event, doctype, name });

  // Find the account that owns this document (via company field)
  const company = (data?.company as string) ?? null;
  if (company) {
    const account = await prisma.account.findFirst({
      where: { erpnextCompany: company },
      select: { id: true },
    });

    if (account) {
      // Publish real-time event to connected clients
      void publish(account.id, {
        type: "erp.doc_updated",
        payload: { event, doctype, name },
        timestamp: new Date().toISOString(),
      });

      void logAudit({
        accountId: account.id,
        action: `erp.webhook.${event}`,
        resource: doctype,
        resourceId: name,
        ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? "",
        userAgent: "system-webhook",
        severity: "info",
        outcome: "success",
      });
    }
  }

  return responseTime().status(200).send("OK");
});

export default router;
