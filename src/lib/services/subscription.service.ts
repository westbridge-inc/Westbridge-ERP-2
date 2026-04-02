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

import { prisma } from "../data/prisma.js";
import { cancelPaddleSubscription } from "../data/paddle.client.js";
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
 * Handle subscription renewal from Paddle webhook (transaction.completed for an existing subscription).
 * Paddle manages the billing cycle — we just extend the local subscription record.
 */
export async function handleRenewal(
  accountId: string,
  transactionId: string,
  paddleSubscriptionId?: string,
): Promise<void> {
  const sub = await prisma.subscription.findFirst({
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
  const result = await prisma.subscription.updateMany({
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
