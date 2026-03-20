/**
 * Billing service: signup (create account + payment session), payment handling.
 *
 * Uses 2Checkout (Verifone) for the ConvertPlus hosted checkout flow.
 * After signup the customer is redirected to 2Checkout's hosted checkout;
 * once they pay, 2Checkout sends an IPN to our webhook endpoint,
 * and we activate the account.
 */

import { prisma } from "../data/prisma.js";
import {
  createPaymentSession,
  isPaymentApproved,
  verifyCallbackSignature,
  type PlanSlug,
  type PaymentCallbackData,
} from "../data/twocheckout.client.js";
import { ok, err, type Result } from "../utils/result.js";
import { sendEmail } from "../email/index.js";
import { accountActivatedEmail } from "../email/templates.js";
import { publish } from "../realtime.js";

const VALID_PLANS: PlanSlug[] = ["Solo", "Starter", "Business", "Enterprise"];

export interface CreateAccountInput {
  email: string;
  companyName: string;
  plan: string;
  modulesSelected?: string[];
  currency?: string;
}

export interface CreateAccountResult {
  accountId: string;
  paymentUrl: string | null;
  status: "pending";
  message?: string;
}

export async function createAccount(
  input: CreateAccountInput,
  returnBaseUrl: string,
): Promise<Result<CreateAccountResult, string>> {
  const { email, companyName, plan, modulesSelected, currency } = input;
  if (!email?.trim() || !companyName?.trim() || !plan?.trim()) {
    return err("Email, company name, and plan are required");
  }
  const planSlug = plan as PlanSlug;
  if (!VALID_PLANS.includes(planSlug)) {
    return err("Invalid plan");
  }

  try {
    const account = await prisma.$transaction(async (tx) => {
      const existing = await tx.account.findUnique({ where: { email: email.trim() } });
      if (existing) {
        if (existing.status === "active") {
          throw new Error("An account with this email already exists. Please sign in.");
        }
        await tx.account.delete({ where: { email: email.trim() } });
      }
      return tx.account.create({
        data: {
          email: email.trim(),
          companyName: companyName.trim(),
          plan: planSlug,
          modulesSelected: Array.isArray(modulesSelected) ? modulesSelected : [],
          status: "pending",
        },
      });
    });

    // The return URL is where 2Checkout will redirect after payment
    const returnUrl = `${returnBaseUrl}/api/webhooks/payment?accountId=${account.id}`;
    const session = await createPaymentSession(planSlug, account.id, returnUrl, currency);

    // If 2Checkout is configured, store the transaction ID
    if (session) {
      await prisma.account.update({
        where: { id: account.id },
        data: { paymentTransactionId: session.transactionId },
      });
    }

    return ok({
      accountId: account.id,
      paymentUrl: session?.redirectUrl ?? null,
      status: "pending" as const,
      ...(session ? {} : { message: "Account created. Payment gateway not configured; contact support to complete." }),
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed to create account");
  }
}

export interface HandlePaymentResult {
  updated: boolean;
  accountId?: string;
}

/**
 * Verify the signature of a 2Checkout IPN callback.
 */
export function verifyPaymentCallback(rawBody: string, signature: string, parsedData?: PaymentCallbackData): boolean {
  return verifyCallbackSignature(rawBody, signature, parsedData);
}

/**
 * Check if a 2Checkout IPN callback indicates success.
 */
export function isPaymentSuccess(data: PaymentCallbackData): boolean {
  return isPaymentApproved(data);
}

/**
 * Activate an account after confirmed payment.
 */
export async function markAccountPaid(
  accountId: string,
  transactionId?: string,
  rrn?: string,
): Promise<Result<HandlePaymentResult, string>> {
  try {
    const result = await prisma.account.updateMany({
      where: { id: accountId },
      data: {
        status: "active",
        paymentTransactionId: transactionId ?? undefined,
        paymentRRN: rrn ?? undefined,
      },
    });
    const updated = (result.count ?? 0) > 0;
    if (updated) {
      // Auto-provision ERPNext company + create subscription (fire-and-forget with retries)
      void import("./provisioning.service.js")
        .then(({ provisionWithRetry }) => provisionWithRetry(accountId))
        .catch(async (e: unknown) => {
          const { logger } = await import("../logger.js");
          logger.error("ERPNext provisioning failed", {
            accountId,
            error: e instanceof Error ? e.message : String(e),
          });
        });

      void import("./subscription.service.js")
        .then(async ({ createSubscription }) => {
          const acc = await prisma.account.findUnique({ where: { id: accountId }, select: { plan: true } });
          if (acc) await createSubscription(accountId, acc.plan);
        })
        .catch(async (e: unknown) => {
          const { logger } = await import("../logger.js");
          logger.error("Subscription creation failed", {
            accountId,
            error: e instanceof Error ? e.message : String(e),
          });
        });

      // Send activation email (fire-and-forget — don't fail if email fails)
      const account = await prisma.account.findUnique({ where: { id: accountId } }).catch(() => null);
      if (account) {
        const loginUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/login`;
        void sendEmail({
          to: account.email,
          subject: "Your Westbridge account is now active",
          html: accountActivatedEmail({ companyName: account.companyName, plan: account.plan, loginUrl }),
        });
      }

      void publish(accountId, {
        type: "notification.new",
        payload: { title: "Payment received", message: "Your subscription has been renewed" },
        timestamp: new Date().toISOString(),
      });
    }
    return ok({ updated, accountId });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed to mark account as paid");
  }
}
