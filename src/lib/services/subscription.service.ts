/**
 * Subscription & recurring billing service.
 *
 * Handles monthly billing cycles using WiPay.
 * - Creates initial subscription on account activation
 * - Monthly cron charges active subscriptions
 * - Handles payment failures with grace period
 * - Supports plan upgrades/downgrades
 */

import { prisma } from "../data/prisma.js";
import { createPaymentSession, type PlanSlug } from "../data/wipay.client.js";
import { sendEmail } from "../email/index.js";
import { ok, err, type Result } from "../utils/result.js";
import { logger } from "../logger.js";

const PLAN_AMOUNTS: Record<string, number> = {
  Solo: 49.99,
  Starter: 199.99,
  Business: 999.99,
  Enterprise: 4999.99,
};

const GRACE_PERIOD_DAYS = 7;

/**
 * Create initial subscription when account is activated after first payment.
 */
export async function createSubscription(
  accountId: string,
  planId: string,
): Promise<Result<{ subscriptionId: string }, string>> {
  try {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const subscription = await prisma.subscription.create({
      data: {
        accountId,
        planId,
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    });

    // Create the first invoice record
    const amount = PLAN_AMOUNTS[planId] ?? 0;
    await prisma.billingInvoice.create({
      data: {
        accountId,
        amount,
        currency: "USD",
        status: "paid",
        planId,
        periodStart: now,
        periodEnd,
        paidAt: now,
      },
    });

    logger.info("Subscription created", { accountId, planId, subscriptionId: subscription.id });
    return ok({ subscriptionId: subscription.id });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed to create subscription");
  }
}

/**
 * Process monthly renewals for all active subscriptions.
 * Called by a cron job (GitHub Actions or BullMQ scheduled job).
 */
export async function processMonthlyRenewals(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  const now = new Date();
  const stats = { processed: 0, succeeded: 0, failed: 0 };

  // Find all active subscriptions whose current period has ended
  const dueSubscriptions = await prisma.subscription.findMany({
    where: {
      status: "active",
      currentPeriodEnd: { lte: now },
    },
    include: {
      account: { select: { id: true, email: true, plan: true, currency: true, status: true } },
    },
  });

  logger.info("Processing monthly renewals", { count: dueSubscriptions.length });

  for (const sub of dueSubscriptions) {
    stats.processed++;

    const amount = PLAN_AMOUNTS[sub.planId] ?? 0;
    if (amount === 0) {
      stats.failed++;
      continue;
    }

    const returnUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/webhooks/wipay?accountId=${sub.accountId}&renewal=true`;

    try {
      // Create payment session for renewal
      const session = await createPaymentSession(
        sub.planId as PlanSlug,
        sub.accountId,
        returnUrl,
        sub.account.currency ?? "USD",
      );

      if (!session) {
        // WiPay not configured — extend subscription anyway (manual billing)
        await extendSubscription(sub.id, sub.planId, sub.accountId);
        stats.succeeded++;
        continue;
      }

      // Create pending invoice
      const periodStart = new Date(sub.currentPeriodEnd);
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      await prisma.billingInvoice.create({
        data: {
          accountId: sub.accountId,
          amount,
          currency: sub.account.currency ?? "USD",
          status: "pending",
          planId: sub.planId,
          periodStart,
          periodEnd,
          transactionId: session.transactionId,
        },
      });

      // Send payment reminder email
      void sendEmail({
        to: sub.account.email,
        subject: `Westbridge - Monthly payment due ($${amount})`,
        html: `
          <h2>Monthly Renewal</h2>
          <p>Your Westbridge ${sub.planId} plan renewal of $${amount} is due.</p>
          <p><a href="${session.redirectUrl}">Complete payment</a></p>
          <p>Your service will continue for ${GRACE_PERIOD_DAYS} days while payment is pending.</p>
        `,
      });

      stats.succeeded++;
    } catch (e) {
      logger.error("Renewal failed", {
        subscriptionId: sub.id,
        error: e instanceof Error ? e.message : String(e),
      });
      stats.failed++;
    }
  }

  // Handle past-due accounts (grace period expired)
  const gracePeriodCutoff = new Date(now.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  await prisma.subscription.updateMany({
    where: {
      status: "active",
      currentPeriodEnd: { lte: gracePeriodCutoff },
    },
    data: { status: "past_due" },
  });

  // Update account status for past_due subscriptions
  const pastDueSubs = await prisma.subscription.findMany({
    where: { status: "past_due" },
    select: { accountId: true },
  });
  if (pastDueSubs.length > 0) {
    await prisma.account.updateMany({
      where: { id: { in: pastDueSubs.map((s) => s.accountId) } },
      data: { status: "past_due" },
    });
  }

  logger.info("Monthly renewals complete", stats);
  return stats;
}

/**
 * Extend a subscription for another month after successful payment.
 */
export async function extendSubscription(
  subscriptionId: string,
  planId: string,
  accountId: string,
  transactionId?: string,
  rrn?: string,
): Promise<void> {
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    }),
    prisma.account.update({
      where: { id: accountId },
      data: { status: "active" },
    }),
  ]);

  // Update or create invoice as paid
  if (transactionId) {
    await prisma.billingInvoice.updateMany({
      where: { accountId, transactionId },
      data: { status: "paid", paidAt: now, rrn },
    });
  }

  logger.info("Subscription extended", { subscriptionId, accountId, periodEnd });
}

/**
 * Upgrade or downgrade a plan.
 */
export async function changePlan(accountId: string, newPlanId: string): Promise<Result<{ message: string }, string>> {
  if (!PLAN_AMOUNTS[newPlanId]) return err("Invalid plan");

  try {
    await prisma.$transaction([
      prisma.account.update({
        where: { id: accountId },
        data: { plan: newPlanId },
      }),
      prisma.subscription.updateMany({
        where: { accountId, status: "active" },
        data: { planId: newPlanId },
      }),
    ]);

    return ok({ message: `Plan changed to ${newPlanId}` });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed to change plan");
  }
}

/**
 * Cancel a subscription.
 */
export async function cancelSubscription(accountId: string): Promise<Result<{ message: string }, string>> {
  try {
    await prisma.$transaction([
      prisma.subscription.updateMany({
        where: { accountId, status: "active" },
        data: { status: "canceled" },
      }),
      prisma.account.update({
        where: { id: accountId },
        data: { status: "canceled" },
      }),
    ]);

    return ok({ message: "Subscription canceled. Access continues until end of billing period." });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed to cancel subscription");
  }
}
