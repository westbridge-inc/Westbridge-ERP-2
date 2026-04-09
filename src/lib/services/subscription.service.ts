/**
 * Subscription & recurring billing service.
 *
 * With Paddle as Merchant of Record, subscription renewals are handled
 * automatically by Paddle. This service:
 *   - Creates initial subscription records on account activation
 *   - Responds to Paddle webhooks for plan changes and cancellations
 *   - Provides plan change and cancellation APIs (which call Paddle)
 *   - Manages grace periods for past-due accounts
 */

import { prismaAdmin } from "../data/prisma-admin.js";
import { cancelPaddleSubscription } from "../data/paddle.client.js";
import { ok, err, type Result } from "../utils/result.js";
import { logger } from "../logger.js";
import { sendEmail } from "../email/index.js";

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

    const subscription = await prismaAdmin.subscription.create({
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
    await prismaAdmin.billingInvoice.create({
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
  } catch {
    return err("Unable to set up your subscription. Please try again or contact support.");
  }
}

/**
 * Handle subscription renewal from Paddle webhook (transaction.completed for an existing subscription).
 * Paddle manages the billing cycle — we just extend the local subscription record.
 */
export async function handleRenewal(
  accountId: string,
  transactionId: string,
  paddleSubscriptionId?: string,
): Promise<void> {
  const sub = await prismaAdmin.subscription.findFirst({
    where: { accountId, status: "active" },
  });

  if (!sub) {
    logger.warn("Renewal webhook but no active subscription found", { accountId });
    return;
  }

  await extendSubscription(sub.id, sub.planId, accountId, transactionId);
  logger.info("Subscription renewed via Paddle webhook", { accountId, transactionId, paddleSubscriptionId });
}

/**
 * Check for past-due accounts whose grace period has expired.
 * Called by a cron job (GitHub Actions or BullMQ scheduled job).
 */
export async function checkGracePeriodExpiry(): Promise<{ updated: number }> {
  const now = new Date();
  const gracePeriodCutoff = new Date(now.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  // Mark subscriptions as past_due if their period ended beyond the grace window
  const result = await prismaAdmin.subscription.updateMany({
    where: {
      status: "active",
      currentPeriodEnd: { lte: gracePeriodCutoff },
    },
    data: { status: "past_due" },
  });

  // Update account status for past_due subscriptions
  const pastDueSubs = await prismaAdmin.subscription.findMany({
    where: { status: "past_due" },
    select: { accountId: true },
  });
  if (pastDueSubs.length > 0) {
    await prismaAdmin.account.updateMany({
      where: { id: { in: pastDueSubs.map((s) => s.accountId) } },
      data: { status: "past_due" },
    });
  }

  logger.info("Grace period check complete", { updated: result.count });
  return { updated: result.count ?? 0 };
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

  await prismaAdmin.$transaction([
    prismaAdmin.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    }),
    prismaAdmin.account.update({
      where: { id: accountId },
      data: { status: "active" },
    }),
  ]);

  // Update or create invoice as paid
  if (transactionId) {
    await prismaAdmin.billingInvoice.updateMany({
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
    await prismaAdmin.$transaction([
      prismaAdmin.account.update({
        where: { id: accountId },
        data: { plan: newPlanId },
      }),
      prismaAdmin.subscription.updateMany({
        where: { accountId, status: "active" },
        data: { planId: newPlanId },
      }),
    ]);

    return ok({ message: `Plan changed to ${newPlanId}` });
  } catch {
    return err("Unable to change your plan right now. Please try again or contact support.");
  }
}

/**
 * Cancel a subscription. If a Paddle subscription ID is known, cancel via
 * the Paddle API (at end of billing period). Otherwise just update local state.
 */
export async function cancelSubscription(
  accountId: string,
  paddleSubscriptionId?: string,
): Promise<Result<{ message: string }, string>> {
  try {
    // Cancel on Paddle side if we have a subscription ID
    if (paddleSubscriptionId) {
      await cancelPaddleSubscription(paddleSubscriptionId);
    }

    await prismaAdmin.$transaction([
      prismaAdmin.subscription.updateMany({
        where: { accountId, status: "active" },
        data: { status: "canceled" },
      }),
      prismaAdmin.account.update({
        where: { id: accountId },
        data: { status: "canceled" },
      }),
    ]);

    return ok({ message: "Subscription canceled. Access continues until end of billing period." });
  } catch {
    return err("Unable to cancel your subscription right now. Please try again or contact support.");
  }
}

// ─── Trial Management ──────────────────────────────────────────────────────────

/**
 * Check for expired trial accounts and mark them as past_due.
 * Run hourly via BullMQ scheduled job.
 */
export async function checkTrialExpiry(): Promise<{ updated: number }> {
  const now = new Date();
  const expiredTrials = await prismaAdmin.account.findMany({
    where: { trialEndsAt: { lte: now }, status: "active" },
    include: { subscriptions: { where: { status: "active", paymentSubscriptionId: { not: null } }, take: 1 } },
  });

  const toBlock = expiredTrials.filter((a) => a.subscriptions.length === 0);
  if (toBlock.length === 0) return { updated: 0 };

  const ids = toBlock.map((a) => a.id);
  await prismaAdmin.$transaction([
    prismaAdmin.account.updateMany({ where: { id: { in: ids } }, data: { status: "past_due" } }),
    prismaAdmin.subscription.updateMany({
      where: { accountId: { in: ids }, status: "trialing" },
      data: { status: "past_due" },
    }),
  ]);

  return { updated: toBlock.length };
}

/**
 * Send warning emails for trials expiring in 3 days and 1 day.
 * Run daily at midnight.
 */
export async function sendTrialWarningEmails(): Promise<{ sent3Day: number; sent1Day: number }> {
  const now = new Date();
  let sent3Day = 0;
  let sent1Day = 0;

  for (const daysAhead of [3, 1]) {
    const target = new Date(now);
    target.setDate(target.getDate() + daysAhead);
    const start = new Date(target);
    start.setHours(start.getHours() - 12);
    const end = new Date(target);
    end.setHours(end.getHours() + 12);

    const accounts = await prismaAdmin.account.findMany({
      where: { status: "active", trialEndsAt: { gte: start, lte: end } },
      select: { id: true, email: true, companyName: true, trialEndsAt: true },
    });

    for (const account of accounts) {
      try {
        await sendEmail({
          to: account.email,
          subject: `Your Westbridge trial ends in ${daysAhead} day${daysAhead === 1 ? "" : "s"}`,
          html: `<p>Your trial for <strong>${account.companyName}</strong> ends soon. <a href="https://westbridgetoday.com/dashboard/settings?tab=billing">Subscribe now</a> to keep your data.</p>`,
        });
        if (daysAhead === 3) sent3Day++;
        else sent1Day++;
      } catch {
        /* continue */
      }
    }
  }

  return { sent3Day, sent1Day };
}

/**
 * Delete data for trial accounts expired 60+ days ago.
 * Run weekly (Sunday 3am).
 */
export async function cleanupExpiredTrialData(): Promise<{ deleted: number }> {
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  const toDelete = await prismaAdmin.account.findMany({
    where: {
      status: { in: ["past_due", "suspended"] },
      trialEndsAt: { lte: sixtyDaysAgo },
      subscriptions: { every: { paymentSubscriptionId: null } },
    },
    select: { id: true },
  });

  for (const account of toDelete) {
    await prismaAdmin.account.update({
      where: { id: account.id },
      data: { status: "deleted" },
    });
  }

  return { deleted: toDelete.length };
}
