/**
 * Billing service: signup (create account), payment handling.
 *
 * Uses Paddle (Merchant of Record) for billing. Checkout happens on the
 * frontend via Paddle.js overlay. After payment, Paddle sends a POST webhook
 * to our backend, and we activate the account.
 */

import { prisma } from "../data/prisma.js";
import { verifyWebhookSignature, type PlanSlug } from "../data/paddle.client.js";
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
  status: "pending";
}

export async function createAccount(
  input: CreateAccountInput,
): Promise<Result<CreateAccountResult, string>> {
  const { email, companyName, plan, modulesSelected } = input;
  if (!email?.trim() || !companyName?.trim() || !plan?.trim()) {
    return err("Email, company name, and plan are required");
  }
  const planSlug = plan as PlanSlug;
  if (!VALID_PLANS.includes(planSlug)) {
    return err("Invalid plan");
  }

  try {
    const account = await prisma.$transaction(async (tx) => {
      // Check for existing account — findFirst bypasses soft-delete filter
      const existing = await tx.account.findFirst({
        where: { email: email.trim(), deletedAt: { not: null } },
      }) ?? await tx.account.findFirst({
        where: { email: email.trim() },
      });

      if (existing) {
        if (existing.status === "active") {
          throw new Error("An account with this email already exists. Please sign in.");
        }
        // Hard-delete pending/soft-deleted accounts so we can reuse the email
        await tx.$executeRaw`DELETE FROM "accounts" WHERE "email" = ${email.trim()}`;
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

    return ok({
      accountId: account.id,
      status: "pending" as const,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // Never leak Prisma/DB internals to the user
    if (msg.includes("Unique constraint") || msg.includes("already exists")) {
      return err("An account with this email already exists. Please sign in.");
    }
    return err("Unable to create your account right now. Please try again.");
  }
}

export interface HandlePaymentResult {
  updated: boolean;
  accountId?: string;
}

/**
 * Verify the signature of a Paddle webhook.
 */
export function verifyPaddleWebhook(rawBody: string, signature: string): boolean {
  return verifyWebhookSignature(rawBody, signature);
}

/**
 * Activate an account after confirmed payment.
 */
export async function markAccountPaid(
  accountId: string,
  transactionId?: string,
  paddleSubscriptionId?: string,
): Promise<Result<HandlePaymentResult, string>> {
  try {
    const result = await prisma.account.updateMany({
      where: { id: accountId },
      data: {
        status: "active",
        paymentTransactionId: transactionId ?? undefined,
        paymentRRN: paddleSubscriptionId ?? undefined,
      },
    });
    const updated = (result.count ?? 0) > 0;
    if (updated) {
      // Auto-provision ERPNext company + create subscription (fire-and-forget with retries)
      void import("./provisioning.service.js").then(({ provisionWithRetry }) => provisionWithRetry(accountId));

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
  } catch (_e) {
    return err("Unable to process your payment right now. Please try again or contact support.");
  }
}
