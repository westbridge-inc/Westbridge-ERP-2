/**
 * Data layer: 2Checkout payment links and IPN verification. Pure I/O.
 */

import { createHash, timingSafeEqual } from "crypto";

const SECRET_WORD = process.env.TWOCO_SECRET_WORD ?? "";

export type PlanSlug = "Starter" | "Business" | "Enterprise";

export function getPaymentLinkUrl(
  plan: PlanSlug,
  accountId: string,
  returnUrl: string
): string {
  const base =
    plan === "Starter"
      ? process.env.TWOCO_LINK_STARTER
      : plan === "Business"
        ? process.env.TWOCO_LINK_BUSINESS
        : process.env.TWOCO_LINK_ENTERPRISE;
  if (!base) return "";
  const url = new URL(base);
  url.searchParams.set("return_url", returnUrl);
  url.searchParams.set("merchant_order_id", accountId);
  url.searchParams.set("external_reference", accountId);
  return url.toString();
}

export function verifyIPNSignature(params: Record<string, string | undefined>): boolean {
  if (!SECRET_WORD) return false;
  const receivedHash = params.MD5_HASH ?? params.HMAC ?? "";
  if (!receivedHash) return false;
  const merchantSid = params.MERCHANT_ORDER_ID ?? params.ORDERNO ?? "";
  const orderNumber = params.ORDERNO ?? params.ORDER_NUMBER ?? "";
  const total = params.TOTAL ?? params.ORDER_TOTAL ?? "";
  const toHash = SECRET_WORD + merchantSid + orderNumber + total;
  // SECURITY NOTE: MD5 is required by 2Checkout's IPN verification protocol.
  // This is not used for password hashing or data integrity — only for verifying
  // the webhook signature as mandated by the payment provider's specification.
  // See: https://verifone.cloud/docs/2checkout/API-Integration/Webhooks/06IPN
  const expected = createHash("md5").update(toHash).digest("hex").toUpperCase(); // codeql[js/weak-cryptographic-algorithm] - required by 2Checkout IPN protocol
  const a = receivedHash.toUpperCase();
  if (a.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(expected, "utf8"));
}

export function isIPNSuccess(params: Record<string, string | undefined>): boolean {
  const msg = params.MESSAGE_TYPE ?? params.ORDER_STATUS ?? "";
  const status = (params.STATUS ?? params.ORDER_STATUS ?? "").toUpperCase();
  return (
    msg === "ORDER_CREATED" ||
    msg === "COMPLETE" ||
    status === "COMPLETE" ||
    status === "APPROVED" ||
    status === "AUTH"
  );
}
