/**
 * Billing service: signup (create account), payment handling.
 *
 * Uses Paddle (Merchant of Record) for billing. Checkout happens on the
 * frontend via Paddle.js overlay. After payment, Paddle sends a POST webhook
 * to our backend, and we activate the account.
 */

import { prisma } from "../data/prisma.js";
import { verifyWebhookSignature, refundPaddleTransaction, type PlanSlug } from "../data/paddle.client.js";
import { ok, err, type Result } from "../utils/result.js";
import { sendEmail } from "../email/index.js";
import { accountActivatedEmail } from "../email/templates.js";
import { publish } from "../realtime.js";
import { hashPassword } from "./auth.service.js";
import { createSession } from "./session.service.js";
import { logger } from "../logger.js";

const VALID_PLANS: PlanSlug[] = ["Solo", "Starter", "Business", "Enterprise"];

export interface CreateAccountInput {
  email: string;
  name: string;
  password: string;
  companyName: string;
  plan: string;
  modulesSelected?: string[];
  currency?: string;
  request?: Request;
}

export interface CreateAccountResult {
  accountId: string;
  userId: string;
  sessionToken: string;
  status: "active";
}

export async function createAccount(input: CreateAccountInput): Promise<Result<CreateAccountResult, string>> {
  const { email, name, password, companyName, plan, modulesSelected, request } = input;
  if (!email?.trim() || !name?.trim() || !password || !companyName?.trim() || !plan?.trim()) {
    return err("Email, name, password, company name, and plan are required");
  }
  if (password.length < 8) {
    return err("Password must be at least 8 characters");
  }
  const planSlug = plan as PlanSlug;
  if (!VALID_PLANS.includes(planSlug)) {
    return err("Invalid plan");
  }

  try {
    const passwordHash = await hashPassword(password);

    const { account, user } = await prisma.$transaction(async (tx) => {
      // Check for existing account — findFirst bypasses soft-delete filter
      const existing =
        (await tx.account.findFirst({
          where: { email: email.trim(), deletedAt: { not: null } },
        })) ??
        (await tx.account.findFirst({
          where: { email: email.trim() },
        }));

      if (existing) {
        if (existing.status === "active") {
          throw new Error("An account with this email already exists. Please sign in.");
        }
        // Hard-delete pending/soft-deleted accounts so we can reuse the email
        await tx.$executeRaw`DELETE FROM "accounts" WHERE "email" = ${email.trim()}`;
      }

      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 14);

      const createdAccount = await tx.account.create({
        data: {
          email: email.trim(),
          companyName: companyName.trim(),
          plan: planSlug,
          modulesSelected: Array.isArray(modulesSelected) ? modulesSelected : [],
          status: "active",
          trialEndsAt,
          trialAiLimit: 10,
        },
      });

      // Create the owner user with the hashed password
      const createdUser = await tx.user.create({
        data: {
          accountId: createdAccount.id,
          email: email.trim(),
          name: name.trim(),
          role: "owner",
          passwordHash,
          status: "active",
        },
      });

      return { account: createdAccount, user: createdUser };
    });

    // Create a session so the user is automatically logged in after signup.
    // Use a minimal Request if none provided (e.g., in tests).
    const req =
      request ?? (new Request("http://localhost/api/signup", { headers: { "user-agent": "signup" } }) as Request);
    const sessionResult = await createSession(user.id, req);
    if (!sessionResult.ok) {
      return err("Account created but unable to start session. Please log in.");
    }

    // Auto-provision ERPNext company + create subscription immediately on signup
    // (fire-and-forget with retries). Without this, trial users would share an
    // unscoped ERPNext instance — a tenant isolation leak. Runs in background so
    // signup stays fast; dashboard endpoints return empty data until provisioning
    // completes (see handleDashboard / handleList).
    void import("./provisioning.service.js")
      .then(({ provisionWithRetry }) => provisionWithRetry(account.id))
      .catch((e: unknown) => {
        logger.error("Provisioning kickoff failed", {
          accountId: account.id,
          error: e instanceof Error ? e.message : String(e),
        });
      });

    void import("./subscription.service.js")
      .then(({ createSubscription }) => createSubscription(account.id, planSlug))
      .catch((e: unknown) => {
        logger.error("Subscription creation failed", {
          accountId: account.id,
          error: e instanceof Error ? e.message : String(e),
        });
      });

    return ok({
      accountId: account.id,
      userId: user.id,
      sessionToken: sessionResult.data.token,
      status: "active" as const,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // Never leak Prisma/DB internals to the user
    if (msg.includes("already exists")) {
      return err("An account with this email already exists. Please sign in.");
    }
    if (msg.includes("Unique constraint")) {
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
        trialEndsAt: null,
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
  } catch {
    return err("Unable to process your payment right now. Please try again or contact support.");
  }
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

const REFUND_WINDOW_DAYS = 14;

export interface RefundRequest {
  invoiceId: string;
  accountId: string;
  reason: string;
  requestedBy: string; // userId of requester
}

export interface RefundResult {
  refunded: boolean;
  amount: string;
  currency: string;
  adjustmentId: string;
}

/**
 * Process a refund for a billing invoice.
 *
 * Policy:
 *   - Refunds allowed within REFUND_WINDOW_DAYS (14) of the original payment
 *   - Already-refunded invoices are rejected
 *   - Only the account owner or admin can request a refund (enforced by route)
 *   - Refund issued through Paddle (Merchant of Record) — funds returned to
 *     original payment method by Paddle within 5-10 business days
 */
export async function refundInvoice(req: RefundRequest): Promise<Result<RefundResult, string>> {
  if (!req.invoiceId || !req.reason?.trim()) {
    return err("Invoice ID and reason are required");
  }

  const invoice = await prisma.billingInvoice
    .findFirst({
      where: { id: req.invoiceId, accountId: req.accountId },
    })
    .catch(() => null);

  if (!invoice) {
    return err("Invoice not found");
  }

  if (invoice.status === "refunded") {
    return err("This invoice has already been refunded");
  }

  if (invoice.status !== "paid") {
    return err("Only paid invoices can be refunded");
  }

  if (!invoice.paidAt) {
    return err("Invoice has no payment date — cannot determine refund eligibility");
  }

  const ageMs = Date.now() - invoice.paidAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > REFUND_WINDOW_DAYS) {
    return err(
      `Refund window has expired. Refunds are available within ${REFUND_WINDOW_DAYS} days of payment. This payment was ${Math.floor(ageDays)} days ago.`,
    );
  }

  if (!invoice.transactionId) {
    return err("Invoice has no payment provider transaction ID — cannot process refund");
  }

  // Issue the refund through Paddle
  const result = await refundPaddleTransaction(invoice.transactionId, req.reason, "full");
  if (!result.ok) {
    logger.error("Refund failed", {
      invoiceId: req.invoiceId,
      accountId: req.accountId,
      reason: result.error,
    });
    return err(result.error);
  }

  // Mark the invoice as refunded
  await prisma.billingInvoice.update({
    where: { id: req.invoiceId },
    data: { status: "refunded" },
  });

  logger.info("Refund processed", {
    invoiceId: req.invoiceId,
    accountId: req.accountId,
    requestedBy: req.requestedBy,
    adjustmentId: result.adjustmentId,
    amount: invoice.amount.toString(),
  });

  // Notify user
  void publish(req.accountId, {
    type: "notification.new",
    payload: {
      title: "Refund processed",
      message: `Your refund of ${invoice.currency} ${invoice.amount.toString()} is on its way (5-10 business days).`,
    },
    timestamp: new Date().toISOString(),
  });

  return ok({
    refunded: true,
    amount: invoice.amount.toString(),
    currency: invoice.currency,
    adjustmentId: result.adjustmentId,
  });
}
