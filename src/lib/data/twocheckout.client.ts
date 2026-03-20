/**
 * Data layer: 2Checkout (Verifone) payment gateway -- ConvertPlus hosted checkout flow.
 *
 * 2Checkout is a global payment processor supporting 45+ payment methods,
 * 100+ currencies, and 200+ markets. This client handles:
 *
 *   1. Creating buy-link URLs for hosted checkout (server -> redirect)
 *   2. Verifying IPN (Instant Payment Notification) callbacks
 *   3. Checking payment status from IPN data
 *
 * Flow:
 *   Server generates a buy-link URL with order parameters -> redirects
 *   customer to 2Checkout hosted checkout -> customer pays -> 2Checkout
 *   sends IPN (form-urlencoded POST) to our webhook -> server verifies
 *   HMAC-MD5 signature and activates account.
 *
 * Docs: https://verifone.cloud/docs/2checkout
 */

import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "../logger.js";

// ---- Environment ----------------------------------------------------------------

const TWOCHECKOUT_MERCHANT_CODE = () => process.env.TWOCHECKOUT_MERCHANT_CODE ?? "";
const TWOCHECKOUT_SECRET_KEY = () => process.env.TWOCHECKOUT_SECRET_KEY ?? "";
const TWOCHECKOUT_TEST_MODE = () => (process.env.TWOCHECKOUT_TEST_MODE ?? "true").toLowerCase() === "true";

/** Checkout base URL -- sandbox for test, production for live. */
function checkoutBaseUrl(): string {
  return TWOCHECKOUT_TEST_MODE()
    ? "https://sandbox.2checkout.com/checkout/buy"
    : "https://secure.2checkout.com/checkout/buy";
}

// ---- Types ----------------------------------------------------------------------

export type PlanSlug = "Solo" | "Starter" | "Business" | "Enterprise";

/**
 * 2Checkout IPN callback data. Sent as application/x-www-form-urlencoded.
 * Field names match the 2Checkout IPN specification.
 */
export interface PaymentCallbackData {
  /** 2Checkout internal order reference */
  REFNO?: string;
  /** Merchant order number */
  ORDERNO?: string;
  /** External reference -- we set this to the accountId */
  REFNOEXT?: string;
  /** Product IDs (array) */
  IPN_PID?: string[];
  /** Product names (array) */
  IPN_PNAME?: string[];
  /** Product prices (array) */
  IPN_PRICE?: string[];
  /** Product quantities (array) */
  IPN_QTY?: string[];
  /** IPN timestamp */
  IPN_DATE?: string;
  /** Order status */
  ORDERSTATUS?: string;
  /** Payment method */
  PAYMETHOD?: string;
  /** Currency */
  CURRENCY?: string;
  /** IPN signature hash */
  HASH?: string;
  /** Fraud status */
  FRAUD_STATUS?: string;
  /** Total amount */
  IPN_TOTALGENERAL?: string;
  /** First name */
  IPN_FIRSTNAME?: string[];
  /** Last name */
  IPN_LASTNAME?: string[];

  // Allow additional 2CO fields we don't explicitly handle
  [key: string]: unknown;
}

// ---- Plan -> Amount Mapping -----------------------------------------------------

const PLAN_AMOUNTS: Record<PlanSlug, number> = {
  Solo: 49.99,
  Starter: 199.99,
  Business: 999.99,
  Enterprise: 4999.99,
};

// ---- Create Payment Session (Buy-Link) ------------------------------------------

/**
 * Create a 2Checkout ConvertPlus buy-link URL. Returns a redirect URL for the
 * customer's browser to complete payment on 2Checkout's hosted checkout page.
 */
export async function createPaymentSession(
  plan: PlanSlug,
  accountId: string,
  returnUrl: string,
  currency: string = "USD",
): Promise<{ redirectUrl: string; transactionId: string } | null> {
  const merchantCode = TWOCHECKOUT_MERCHANT_CODE();
  const secretKey = TWOCHECKOUT_SECRET_KEY();

  if (!merchantCode || !secretKey) {
    logger.warn("2Checkout credentials not configured -- skipping payment session creation");
    return null;
  }

  const amount = PLAN_AMOUNTS[plan];
  if (!amount) {
    logger.error("Invalid plan for payment session", { plan });
    return null;
  }

  const transactionId = `WB-${accountId}-${Date.now()}`;

  // Build 2Checkout ConvertPlus buy-link URL
  const params = new URLSearchParams({
    merchant: merchantCode,
    dynamic: "1",
    tpl: "default",
    prod: plan,
    price: amount.toFixed(2),
    type: "product",
    currency: currency.toUpperCase(),
    "return-url": returnUrl,
    "return-type": "redirect",
    expiration: "30",
    "order-ext-ref": accountId,
    src: "westbridge",
  });

  const redirectUrl = `${checkoutBaseUrl()}?${params.toString()}`;

  logger.info("2Checkout payment session created", {
    plan,
    accountId,
    transactionId,
    testMode: TWOCHECKOUT_TEST_MODE(),
  });

  return {
    redirectUrl,
    transactionId,
  };
}

// ---- Payment Verification -------------------------------------------------------

/**
 * Check if a 2Checkout IPN callback indicates a successful payment.
 * ORDERSTATUS "COMPLETE" means the payment was approved and settled.
 */
export function isPaymentApproved(data: PaymentCallbackData): boolean {
  const status = (data.ORDERSTATUS ?? "").toUpperCase();
  return status === "COMPLETE" || status === "PAYMENT_AUTHORIZED";
}

/**
 * Compute the HMAC-MD5 signature for an IPN field value.
 * 2Checkout IPN signature format: for each value, prepend its byte-length
 * then the value itself. Arrays are expanded in order.
 */
function ipnSerializeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((v) => ipnSerializeValue(v)).join("");
  }
  const str = String(value ?? "");
  const byteLength = Buffer.byteLength(str, "utf8");
  return `${byteLength}${str}`;
}

/**
 * Compute the expected IPN hash from the received parameters.
 *
 * 2Checkout IPN signature: HMAC-MD5 over a concatenation of
 * length-prefixed field values, using the merchant secret key.
 *
 * The fields included in the hash are (in order):
 * IPN_PID, IPN_PNAME, IPN_DATE, and IPN_DATE again for confirmation.
 */
function computeIpnHash(data: PaymentCallbackData, secretKey: string): string {
  // Build the source string from IPN fields (length-prefixed values)
  // Standard 2CO IPN hash covers these fields in order
  const fieldsToHash = ["IPN_PID", "IPN_PNAME", "IPN_DATE"] as const;

  let source = "";
  for (const field of fieldsToHash) {
    const value = data[field];
    source += ipnSerializeValue(value);
  }

  return createHmac("md5", secretKey).update(source).digest("hex");
}

/**
 * Verify the HMAC-MD5 signature of a 2Checkout IPN callback.
 *
 * @param rawBody - Not used for 2CO IPN (signature is computed from parsed fields)
 * @param signature - The HASH value sent in the IPN
 * @param parsedData - The parsed IPN form data (needed to recompute the hash)
 */
export function verifyCallbackSignature(rawBody: string, signature: string, parsedData?: PaymentCallbackData): boolean {
  const secret = TWOCHECKOUT_SECRET_KEY();
  if (!secret || !signature) return false;

  // 2Checkout IPN verification works on parsed field values, not raw body.
  // If parsedData is not provided, we cannot verify.
  if (!parsedData) return false;

  const expected = computeIpnHash(parsedData, secret);

  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
}

/**
 * Generate the IPN response that 2Checkout expects.
 *
 * 2Checkout requires IPN responses in the format:
 *   <EPAYMENT>DATE|HASH</EPAYMENT>
 *
 * where DATE is the IPN_DATE and HASH is HMAC-MD5 of the date string
 * (length-prefixed) with the secret key.
 */
export function generateIpnResponse(ipnDate: string): string {
  const secret = TWOCHECKOUT_SECRET_KEY();
  const serialized = ipnSerializeValue(ipnDate);
  const hash = createHmac("md5", secret).update(serialized).digest("hex");
  return `<EPAYMENT>${ipnDate}|${hash}</EPAYMENT>`;
}
