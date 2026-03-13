/**
 * Billing service: signup (create account + payment session), payment handling.
 *
 * Uses PowerTranz (Caribbean-focused payment processor) for the Hosted Payment
 * Page (HPP) flow. After signup the customer is redirected to PowerTranz's
 * hosted page; once they pay, PowerTranz POSTs back to our webhook endpoint,
 * and we activate the account.
 */

import { prisma } from "../data/prisma.js";
import {
  createPaymentSession,
  isPaymentApproved,
  verifyCallbackSignature,
  type PlanSlug,
  type PaymentCallbackData,
} from "../data/powertranz.client.js";
import { ok, err, type Result } from "../utils/result.js";
import { sendEmail } from "../email/index.js";
import { accountActivatedEmail } from "../email/templates.js";

const VALID_PLANS: PlanSlug[] = ["Starter", "Business", "Enterprise"];

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

    // The return URL is where PowerTranz will POST the payment result
    const returnUrl = `${returnBaseUrl}/api/webhooks/powertranz?accountId=${account.id}`;
    const session = await createPaymentSession(planSlug, account.id, returnUrl, currency);

    // If PowerTranz is configured, store the transaction ID
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
 * Verify the signature of a PowerTranz callback.
 */
export function verifyPaymentCallback(rawBody: string, signature: string): boolean {
  return verifyCallbackSignature(rawBody, signature);
}

/**
 * Check if a PowerTranz payment callback indicates success.
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
    }
    return ok({ updated, accountId });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed to mark account as paid");
  }
}
