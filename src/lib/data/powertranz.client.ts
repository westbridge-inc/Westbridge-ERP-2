/**
 * Data layer: PowerTranz payment gateway — Hosted Payment Page (HPP) flow.
 *
 * PowerTranz is a Caribbean-focused payment processor supporting USD, GYD,
 * TTD, JMD, XCD, and BMD. This client handles:
 *
 *   1. Creating SPI payment sessions (server → PowerTranz)
 *   2. Verifying payment completion callbacks
 *   3. Checking payment response codes
 *
 * Flow:
 *   Server calls /Api/Spi/Auth → gets SPI token → redirects customer to
 *   hosted payment page → customer pays → PowerTranz redirects back with
 *   result → server verifies and activates account.
 *
 * Docs: https://developers.powertranz.com
 */

import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "../logger.js";

// ─── Environment ──────────────────────────────────────────────────────────────

const POWERTRANZ_ID = () => process.env.POWERTRANZ_ID ?? "";
const POWERTRANZ_PASSWORD = () => process.env.POWERTRANZ_PASSWORD ?? "";
const POWERTRANZ_TEST_MODE = () => (process.env.POWERTRANZ_TEST_MODE ?? "true").toLowerCase() === "true";

/** Base URL — staging for test, production for live. */
function baseUrl(): string {
  return POWERTRANZ_TEST_MODE() ? "https://staging.ptranz.com" : "https://ptranz.com";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlanSlug = "Starter" | "Business" | "Enterprise";

export interface SpiAuthRequest {
  TransactionIdentifier: string;
  TotalAmount: number;
  CurrencyCode: string; // ISO 4217 numeric: "840" = USD, "328" = GYD
  ThreeDSecure: boolean;
  Source: {
    CardPan?: string;
    CardCvv?: string;
    CardExpiration?: string;
    CardholderName?: string;
  };
  AddressMatch: boolean;
  ExtendedData?: {
    ThreeDSecure?: {
      ChallengeWindowSize: number;
      ChallengeIndicator: string;
    };
    MerchantResponseUrl: string;
    HostedPage?: {
      PageSet: string;
      PageName: string;
    };
  };
  OrderIdentifier: string;
  BillingAddress?: {
    FirstName?: string;
    LastName?: string;
    Line1?: string;
    City?: string;
    State?: string;
    PostalCode?: string;
    CountryCode?: string;
    EmailAddress?: string;
    PhoneNumber?: string;
  };
}

export interface SpiAuthResponse {
  SpiToken: string;
  RedirectUrl?: string;
  Approved: boolean;
  ResponseCode: string;
  ResponseMessage?: string;
  TransactionIdentifier: string;
  OrderIdentifier: string;
  RRN?: string; // Retrieval Reference Number
  IsoResponseCode?: string;
  Errors?: Array<{ Code: string; Message: string }>;
}

export interface PaymentCallbackData {
  SpiToken?: string;
  TransactionIdentifier?: string;
  OrderIdentifier?: string;
  Approved?: boolean;
  ResponseCode?: string;
  ResponseMessage?: string;
  RRN?: string;
  IsoResponseCode?: string;
  TotalAmount?: number;
  CurrencyCode?: string;
}

// ─── Plan → Amount Mapping ────────────────────────────────────────────────────

const PLAN_AMOUNTS: Record<PlanSlug, number> = {
  Starter: 500.0,
  Business: 1000.0,
  Enterprise: 5000.0,
};

/** ISO 4217 numeric currency codes. */
const CURRENCY_CODES: Record<string, string> = {
  USD: "840",
  GYD: "328",
  TTD: "780",
  JMD: "388",
  XCD: "951",
  BMD: "060",
};

// ─── SPI Auth (Create Payment Session) ────────────────────────────────────────

/**
 * Create an SPI payment session. Returns a redirect URL for the customer's
 * browser to complete payment on PowerTranz's hosted payment page.
 */
export async function createPaymentSession(
  plan: PlanSlug,
  accountId: string,
  returnUrl: string,
  currency: string = "USD",
): Promise<{ redirectUrl: string; spiToken: string; transactionId: string } | null> {
  const ptzId = POWERTRANZ_ID();
  const ptzPassword = POWERTRANZ_PASSWORD();

  if (!ptzId || !ptzPassword) {
    logger.warn("PowerTranz credentials not configured — skipping payment session creation");
    return null;
  }

  const amount = PLAN_AMOUNTS[plan];
  if (!amount) {
    logger.error("Invalid plan for payment session", { plan });
    return null;
  }

  const currencyCode = CURRENCY_CODES[currency.toUpperCase()] ?? CURRENCY_CODES.USD;
  const transactionId = `WB-${accountId}-${Date.now()}`;

  const payload: SpiAuthRequest = {
    TransactionIdentifier: transactionId,
    TotalAmount: amount,
    CurrencyCode: currencyCode,
    ThreeDSecure: true,
    Source: {},
    AddressMatch: false,
    ExtendedData: {
      ThreeDSecure: {
        ChallengeWindowSize: 5,
        ChallengeIndicator: "01",
      },
      MerchantResponseUrl: returnUrl,
    },
    OrderIdentifier: accountId,
  };

  try {
    const response = await fetch(`${baseUrl()}/Api/Spi/Auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "PowerTranz-PowerTranzId": ptzId,
        "PowerTranz-PowerTranzPassword": ptzPassword,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.error("PowerTranz SPI Auth failed", {
        status: response.status,
        body: text.slice(0, 500),
      });
      return null;
    }

    const data = (await response.json()) as SpiAuthResponse;

    if (data.Errors && data.Errors.length > 0) {
      logger.error("PowerTranz SPI Auth returned errors", { errors: data.Errors });
      return null;
    }

    if (!data.SpiToken) {
      logger.error("PowerTranz SPI Auth did not return SpiToken", { data });
      return null;
    }

    // The redirect URL is the hosted payment page with the SPI token
    const redirectUrl = data.RedirectUrl ?? `${baseUrl()}/Api/Spi/Payment?SpiToken=${data.SpiToken}`;

    return {
      redirectUrl,
      spiToken: data.SpiToken,
      transactionId,
    };
  } catch (error) {
    logger.error("PowerTranz SPI Auth request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ─── Payment Verification ─────────────────────────────────────────────────────

/**
 * Verify a payment completion callback from PowerTranz.
 * After the customer completes payment on the hosted page, PowerTranz
 * POSTs back to our MerchantResponseUrl with the result.
 */
export function isPaymentApproved(data: PaymentCallbackData): boolean {
  // ResponseCode "00" = Approved in PowerTranz
  return data.Approved === true || data.ResponseCode === "00";
}

/**
 * Verify the HMAC signature of a PowerTranz callback (if provided).
 * PowerTranz signs callbacks with the merchant password.
 */
export function verifyCallbackSignature(rawBody: string, receivedSignature: string): boolean {
  const secret = POWERTRANZ_PASSWORD();
  if (!secret || !receivedSignature) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  if (expected.length !== receivedSignature.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(receivedSignature, "utf8"));
}

/**
 * Look up a transaction by its identifier (for reconciliation).
 */
export async function getTransaction(transactionId: string): Promise<PaymentCallbackData | null> {
  const ptzId = POWERTRANZ_ID();
  const ptzPassword = POWERTRANZ_PASSWORD();
  if (!ptzId || !ptzPassword) return null;

  try {
    const response = await fetch(`${baseUrl()}/Api/Transactions/${encodeURIComponent(transactionId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "PowerTranz-PowerTranzId": ptzId,
        "PowerTranz-PowerTranzPassword": ptzPassword,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return null;
    return (await response.json()) as PaymentCallbackData;
  } catch {
    return null;
  }
}

/**
 * Process a refund for a given transaction.
 */
export async function refundTransaction(
  transactionId: string,
  amount?: number,
): Promise<{ success: boolean; responseCode?: string; message?: string }> {
  const ptzId = POWERTRANZ_ID();
  const ptzPassword = POWERTRANZ_PASSWORD();
  if (!ptzId || !ptzPassword) {
    return { success: false, message: "PowerTranz credentials not configured" };
  }

  try {
    const payload: Record<string, unknown> = {
      TransactionIdentifier: transactionId,
    };
    if (amount !== undefined) {
      payload.TotalAmount = amount;
    }

    const response = await fetch(`${baseUrl()}/Api/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "PowerTranz-PowerTranzId": ptzId,
        "PowerTranz-PowerTranzPassword": ptzPassword,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      return { success: false, message: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as SpiAuthResponse;
    return {
      success: data.Approved || data.ResponseCode === "00",
      responseCode: data.ResponseCode,
      message: data.ResponseMessage,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
