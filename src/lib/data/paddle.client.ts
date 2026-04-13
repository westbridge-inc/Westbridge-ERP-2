/**
 * Data layer: Paddle Billing v2 — Merchant of Record.
 *
 * Paddle handles checkout on the frontend via Paddle.js overlay. The backend
 * only needs to:
 *
 *   1. Verify webhook signatures (HMAC-SHA256)
 *   2. Fetch subscription details from the Paddle API
 *   3. Cancel subscriptions via the Paddle API
 *
 * Flow:
 *   Frontend opens Paddle.js overlay with price ID + custom_data.accountId ->
 *   customer pays on Paddle's UI -> Paddle sends POST webhook to our endpoint
 *   with Paddle-Signature header -> backend verifies signature, processes event,
 *   and activates/updates account.
 *
 * Docs: https://developer.paddle.com/webhooks/overview
 */

import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "../logger.js";

// ─── Environment ──────────────────────────────────────────────────────────────

const PADDLE_API_KEY = () => process.env.PADDLE_API_KEY ?? "";
const PADDLE_WEBHOOK_SECRET = () => process.env.PADDLE_WEBHOOK_SECRET ?? "";
const PADDLE_SANDBOX = () => (process.env.PADDLE_SANDBOX ?? "true") === "true";
const PADDLE_API_URL =  => (PADDLE_SANDBOX ? "https://sandbox-api.paddle.com" : "https://api.paddle.com");

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlanSlug = "Solo" | "Starter" | "Business" | "Enterprise";

// ─── Plan -> Paddle Price ID Mapping ────────────────────────────────────────

const PLAN_PRICE_IDS: Record<PlanSlug, string> = {
  Solo: process.env.PADDLE_PRICE_SOLO ?? "",
  Starter: process.env.PADDLE_PRICE_STARTER ?? "",
  Business: process.env.PADDLE_PRICE_BUSINESS ?? "",
  Enterprise: process.env.PADDLE_PRICE_ENTERPRISE ?? "",
};

// ─── Plan -> Amount Mapping (for display purposes) ──────────────────────────

export const PLAN_AMOUNTS: Record<PlanSlug, number> = {
  Solo: 49.99,
  Starter: 199.99,
  Business: 999.99,
  Enterprise: 4999.99,
};

// ─── Price ID Lookup ────────────────────────────────────────────────────────

/**
 * Get the Paddle price ID for a plan slug.
 */
export function getPriceId(plan: PlanSlug): string {
  return PLAN_PRICE_IDS[plan] ?? "";
}

// ─── Webhook Signature Verification ─────────────────────────────────────────

/**
 * Verify a Paddle webhook signature (HMAC-SHA256).
 *
 * Paddle sends the signature in the `Paddle-Signature` header with format:
 *   ts=<timestamp>;h1=<hash>
 *
 * The hash is HMAC-SHA256 of `<timestamp>:<rawBody>` using the webhook secret.
 *
 * @param rawBody - The raw request body string
 * @param signature - The Paddle-Signature header value
 * @returns true if the signature is valid
 */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = PADDLE_WEBHOOK_SECRET();
  if (!secret) {
    logger.warn("Paddle webhook secret not configured — cannot verify signature");
    return false;
  }

  if (!rawBody || !signature) return false;

  // Parse "ts=<timestamp>;h1=<hash>" format
  const parts: Record<string, string> = {};
  for (const part of signature.split(";")) {
    const [key, ...valueParts] = part.split("=");
    if (key && valueParts.length > 0) {
      parts[key.trim()] = valueParts.join("=").trim();
    }
  }

  const ts = parts["ts"];
  const h1 = parts["h1"];
  if (!ts || !h1) {
    logger.warn("Paddle webhook signature missing ts or h1 component", { signature });
    return false;
  }

  const payload = `${ts}:${rawBody}`;
  const expectedHash = createHmac("sha256", secret).update(payload).digest("hex");

  // Timing-safe comparison to prevent timing attacks
  try {
    const expectedBuffer = Buffer.from(expectedHash, "hex");
    const actualBuffer = Buffer.from(h1, "hex");
    if (expectedBuffer.length !== actualBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}

// ─── Paddle API: Get Subscription ───────────────────────────────────────────

/**
 * Fetch a subscription from the Paddle API.
 */
export async function getSubscription(subscriptionId: string): Promise<Record<string, unknown> | null> {
  const apiKey = PADDLE_API_KEY();
  if (!apiKey) {
    logger.warn("Paddle API key not configured — cannot fetch subscription");
    return null;
  }

  try {
    const response = await fetch(`${PADDLE_API_URL()}/subscriptions/${subscriptionId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      logger.error("Paddle getSubscription failed", {
        status: response.status,
        subscriptionId,
      });
      return null;
    }

    const data = (await response.json()) as { data?: Record<string, unknown> };
    return data.data ?? null;
  } catch (error) {
    logger.error("Paddle getSubscription error", {
      subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ─── Paddle API: Cancel Subscription ────────────────────────────────────────

/**
 * Cancel a subscription at the end of the current billing period.
 */
export async function cancelPaddleSubscription(subscriptionId: string): Promise<boolean> {
  const apiKey = PADDLE_API_KEY();
  if (!apiKey) {
    logger.warn("Paddle API key not configured — cannot cancel subscription");
    return false;
  }

  try {
    const response = await fetch(`${PADDLE_API_URL()}/subscriptions/${subscriptionId}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ effective_from: "next_billing_period" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      logger.error("Paddle cancelSubscription failed", {
        status: response.status,
        subscriptionId,
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.error("Paddle cancelSubscription error", {
      subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Issue a refund for a Paddle transaction.
 * Per Paddle API: POST /adjustments creates a refund adjustment.
 *
 * @param transactionId - the Paddle transaction ID to refund (from billing_invoices.transactionId)
 * @param reason - human-readable reason (logged + sent to Paddle)
 * @param type - "full" refunds the entire transaction, "partial" requires lineItemAmounts
 * @param lineItems - for partial refunds, array of { item_id, amount } in minor currency units
 * @returns { ok: true, adjustmentId } on success, { ok: false, error } on failure
 */
export async function refundPaddleTransaction(
  transactionId: string,
  reason: string,
  type: "full" | "partial" = "full",
  lineItems?: Array<{ itemId: string; amount: string }>,
): Promise<{ ok: true; adjustmentId: string } | { ok: false; error: string }> {
  const apiKey = PADDLE_API_KEY();
  if (!apiKey) {
    return { ok: false, error: "Paddle API key not configured" };
  }
  if (!transactionId?.trim()) {
    return { ok: false, error: "transactionId is required" };
  }
  if (!reason?.trim()) {
    return { ok: false, error: "reason is required" };
  }

  // Build adjustment payload per Paddle API spec
  const items =
    type === "full"
      ? [{ type: "full", item_id: "all" }]
      : (lineItems ?? []).map((li) => ({ type: "partial", item_id: li.itemId, amount: li.amount }));

  if (type === "partial" && items.length === 0) {
    return { ok: false, error: "lineItems required for partial refunds" };
  }

  try {
    const response = await fetch(`${PADDLE_API_URL()}/adjustments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "refund",
        transaction_id: transactionId,
        reason,
        items,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const body = (await response.json().catch(() => ({}))) as {
      data?: { id?: string };
      error?: { detail?: string };
    };

    if (!response.ok) {
      const detail = body.error?.detail ?? `HTTP ${response.status}`;
      logger.error("Paddle refund failed", { transactionId, status: response.status, detail });
      return { ok: false, error: `Refund failed: ${detail}` };
    }

    const adjustmentId = body.data?.id ?? "";
    logger.info("Paddle refund created", { transactionId, adjustmentId, type });
    return { ok: true, adjustmentId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Paddle refund error", { transactionId, error: msg });
    return { ok: false, error: "Unable to process refund. Please try again." };
  }
}
