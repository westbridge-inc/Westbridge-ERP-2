/**
 * Data layer: WiPay payment gateway — Hosted Payment Page flow.
 *
 * WiPay is a Caribbean-focused payment processor supporting USD, TTD, JMD.
 * This client handles:
 *
 *   1. Creating payment sessions (server -> WiPay)
 *   2. Verifying payment completion via callback query params
 *   3. Checking payment status from browser redirect
 *
 * Flow:
 *   Server POSTs to /plugins/payments/request -> gets hosted page URL ->
 *   redirects customer to hosted payment page -> customer pays -> WiPay
 *   redirects browser back to response_url with query params (status,
 *   order_id, transaction_id, hash) -> server verifies and activates account.
 *
 * IMPORTANT: WiPay uses browser GET redirect, NOT server-to-server POST.
 *
 * Docs: https://wipayfinancial.com/developers
 */

import { createHash } from "crypto";
import { logger } from "../logger.js";

// ─── Environment ──────────────────────────────────────────────────────────────

const WIPAY_ACCOUNT_NUMBER = () => process.env.WIPAY_ACCOUNT_NUMBER ?? "";
const WIPAY_API_KEY = () => process.env.WIPAY_API_KEY ?? "";
const WIPAY_SANDBOX = () => (process.env.WIPAY_SANDBOX ?? "true").toLowerCase() === "true";
const WIPAY_COUNTRY_CODE = () => process.env.WIPAY_COUNTRY_CODE ?? "GY";

/** WiPay Guyana endpoint. */
const WIPAY_ENDPOINT = "https://gy.wipayfinancial.com/plugins/payments/request";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlanSlug = "Solo" | "Starter" | "Business" | "Enterprise";

export interface PaymentCallbackData {
  status?: string;
  order_id?: string;
  transaction_id?: string;
  hash?: string;
  reasonDescription?: string;
}

// ─── Plan -> Amount Mapping ──────────────────────────────────────────────────

const PLAN_AMOUNTS: Record<PlanSlug, number> = {
  Solo: 49.99,
  Starter: 199.99,
  Business: 999.99,
  Enterprise: 4999.99,
};

// ─── Create Payment Session ──────────────────────────────────────────────────

/**
 * Create a WiPay payment session. Returns a redirect URL for the customer's
 * browser to complete payment on WiPay's hosted payment page.
 */
export async function createPaymentSession(
  plan: PlanSlug,
  accountId: string,
  returnUrl: string,
  currency: string = "USD",
): Promise<{ redirectUrl: string; transactionId: string } | null> {
  const accountNumber = WIPAY_ACCOUNT_NUMBER();
  const apiKey = WIPAY_API_KEY();

  if (!accountNumber || !apiKey) {
    logger.warn("WiPay credentials not configured — skipping payment session creation");
    return null;
  }

  const amount = PLAN_AMOUNTS[plan];
  if (!amount) {
    logger.error("Invalid plan for payment session", { plan });
    return null;
  }

  const orderId = `WB-${accountId}-${Date.now()}`;
  const environment = WIPAY_SANDBOX() ? "sandbox" : "live";
  const currencyCode = ["USD", "TTD", "JMD"].includes(currency.toUpperCase()) ? currency.toUpperCase() : "USD";

  const params = new URLSearchParams();
  params.append("account_number", accountNumber);
  params.append("country_code", WIPAY_COUNTRY_CODE());
  params.append("currency", currencyCode);
  params.append("environment", environment);
  params.append("fee_structure", "customer_pay");
  params.append("method", "credit_card");
  params.append("order_id", orderId);
  params.append("origin", "westbridge-erp");
  params.append("response_url", returnUrl);
  params.append("total", amount.toFixed(2));

  try {
    const response = await fetch(WIPAY_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    const data = (await response.json()) as {
      url?: string;
      message?: string;
      transaction_id?: string;
    };

    if (!response.ok || response.status >= 400) {
      logger.error("WiPay payment request failed", {
        status: response.status,
        message: data.message,
        transaction_id: data.transaction_id,
      });
      return null;
    }

    if (!data.url) {
      logger.error("WiPay payment request did not return a redirect URL", { data });
      return null;
    }

    return {
      redirectUrl: data.url,
      transactionId: data.transaction_id ?? orderId,
    };
  } catch (error) {
    logger.error("WiPay payment request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ─── Payment Verification ─────────────────────────────────────────────────────

/**
 * Check if a WiPay callback indicates a successful payment.
 * WiPay redirects the browser to response_url with query params including `status`.
 */
export function isPaymentApproved(data: PaymentCallbackData): boolean {
  return data.status === "success";
}

/**
 * Verify the MD5 hash from a WiPay callback.
 * WiPay appends a hash to the response_url query string for verification.
 * The hash is an MD5 of: order_id + status + transaction_id + API key.
 */
export function verifyCallbackHash(params: PaymentCallbackData): boolean {
  const apiKey = WIPAY_API_KEY();
  if (!apiKey) return false;

  const { order_id, status, transaction_id, hash } = params;
  if (!order_id || !status || !transaction_id || !hash) return false;

  const expected = createHash("md5").update(`${order_id}${status}${transaction_id}${apiKey}`).digest("hex");

  return expected.toLowerCase() === hash.toLowerCase();
}
