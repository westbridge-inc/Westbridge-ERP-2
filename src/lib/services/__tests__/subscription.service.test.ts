/**
 * subscription.service tests
 *
 * Mocks (3 — external boundaries only):
 *   1. prisma          — database
 *   2. paddle.client   — external payment API
 *   3. email/index     — Resend email API
 *
 * Internal modules running for real:
 *   - logger (suppressed in test)
 *   - result.js (ok/err utilities)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma-admin.js", () => ({
  prismaAdmin: {
    subscription: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    billingInvoice: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    account: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../../data/paddle.client.js", () => ({
  cancelPaddleSubscription: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../email/index.js", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true }),
}));

// Logger: suppress output in tests
vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createSubscription,
  handleRenewal,
  checkGracePeriodExpiry,
  extendSubscription,
  changePlan,
  cancelSubscription,
  checkTrialExpiry,
  sendTrialWarningEmails,
  cleanupExpiredTrialData,
} from "../subscription.service.js";
import { prismaAdmin } from "../../data/prisma-admin.js";
import { sendEmail } from "../../email/index.js";
import { cancelPaddleSubscription } from "../../data/paddle.client.js";

describe("subscription.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSubscription", () => {
    it("creates subscription and invoice", async () => {
      (prismaAdmin.subscription.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sub_1" });
      (prismaAdmin.billingInvoice.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv_1" });

      const result = await createSubscription("acc_1", "Starter");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.subscriptionId).toBe("sub_1");
    });

    it("handles errors", async () => {
      (prismaAdmin.subscription.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db err"));

      const result = await createSubscription("acc_1", "Starter");
      expect(result.ok).toBe(false);
    });
  });

  describe("handleRenewal", () => {
    it("extends subscription when active sub exists", async () => {
      (prismaAdmin.subscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "sub_1",
        planId: "Starter",
      });
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await handleRenewal("acc_1", "txn_1", "paddle_sub_1");
      expect(prismaAdmin.$transaction).toHaveBeenCalled();
    });

    it("logs warning when no active subscription found", async () => {
      (prismaAdmin.subscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await handleRenewal("acc_1", "txn_1");
      // Should not throw
    });
  });

  describe("checkGracePeriodExpiry", () => {
    it("marks expired subscriptions as past_due", async () => {
      (prismaAdmin.subscription.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
      (prismaAdmin.subscription.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { accountId: "acc_1" },
        { accountId: "acc_2" },
      ]);
      (prismaAdmin.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

      const result = await checkGracePeriodExpiry();
      expect(result.updated).toBe(2);
    });
  });

  describe("extendSubscription", () => {
    it("extends subscription period", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await extendSubscription("sub_1", "Starter", "acc_1");
      expect(prismaAdmin.$transaction).toHaveBeenCalled();
    });

    it("updates invoice when transactionId provided", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prismaAdmin.billingInvoice.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await extendSubscription("sub_1", "Starter", "acc_1", "txn_1", "rrn_1");
      expect(prismaAdmin.billingInvoice.updateMany).toHaveBeenCalled();
    });
  });

  describe("changePlan", () => {
    it("changes plan successfully", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await changePlan("acc_1", "Business");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.message).toContain("Business");
    });

    it("returns error for invalid plan", async () => {
      const result = await changePlan("acc_1", "InvalidPlan");
      expect(result.ok).toBe(false);
    });

    it("handles errors", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db err"));

      const result = await changePlan("acc_1", "Business");
      expect(result.ok).toBe(false);
    });
  });

  describe("cancelSubscription", () => {
    it("cancels subscription", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await cancelSubscription("acc_1");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.message).toContain("canceled");
    });

    it("cancels on Paddle when subscription ID provided", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await cancelSubscription("acc_1", "paddle_sub_123");
      expect(result.ok).toBe(true);
      expect(cancelPaddleSubscription).toHaveBeenCalledWith("paddle_sub_123");
    });

    it("handles errors", async () => {
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db err"));

      const result = await cancelSubscription("acc_1");
      expect(result.ok).toBe(false);
    });
  });

  // ── Trial system tests ──────────────────────────────────────────────────

  describe("checkTrialExpiry", () => {
    it("marks expired trial accounts without paid subscriptions as past_due", async () => {
      const expiredAccount = {
        id: "acc_1",
        trialEndsAt: new Date(Date.now() - 86400000),
        status: "active",
        subscriptions: [],
      };
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([expiredAccount]);
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await checkTrialExpiry();

      expect(result.updated).toBe(1);
      expect(prismaAdmin.$transaction).toHaveBeenCalled();
    });

    it("does not block accounts with active paid subscriptions", async () => {
      const accountWithSub = {
        id: "acc_1",
        trialEndsAt: new Date(Date.now() - 86400000),
        status: "active",
        subscriptions: [{ id: "sub_1", paymentSubscriptionId: "paddle_sub_1" }],
      };
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([accountWithSub]);

      const result = await checkTrialExpiry();

      expect(result.updated).toBe(0);
      // $transaction should NOT be called since there's nothing to block
    });

    it("returns zero when no expired trials exist", async () => {
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await checkTrialExpiry();

      expect(result.updated).toBe(0);
    });

    it("handles multiple expired accounts", async () => {
      const expired = [
        { id: "acc_1", subscriptions: [] },
        { id: "acc_2", subscriptions: [] },
        { id: "acc_3", subscriptions: [{ paymentSubscriptionId: "paid" }] },
      ];
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(expired);
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await checkTrialExpiry();

      // acc_3 has a paid subscription, so only acc_1 and acc_2 should be blocked
      expect(result.updated).toBe(2);
    });
  });

  describe("sendTrialWarningEmails", () => {
    it("sends 3-day warning emails", async () => {
      const threeDaysOut = new Date();
      threeDaysOut.setDate(threeDaysOut.getDate() + 3);

      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: "acc_1", email: "a@b.com", companyName: "TestCo", trialEndsAt: threeDaysOut }])
        .mockResolvedValueOnce([]);

      const result = await sendTrialWarningEmails();

      expect(result.sent3Day).toBe(1);
      expect(result.sent1Day).toBe(0);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "a@b.com",
          subject: expect.stringContaining("3 days"),
        }),
      );
    });

    it("sends 1-day warning emails", async () => {
      const oneDayOut = new Date();
      oneDayOut.setDate(oneDayOut.getDate() + 1);

      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "acc_2", email: "c@d.com", companyName: "Co2", trialEndsAt: oneDayOut }]);

      const result = await sendTrialWarningEmails();

      expect(result.sent3Day).toBe(0);
      expect(result.sent1Day).toBe(1);
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining("1 day"),
        }),
      );
    });

    it("continues sending if individual email fails", async () => {
      const threeDaysOut = new Date();
      threeDaysOut.setDate(threeDaysOut.getDate() + 3);

      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { id: "acc_1", email: "a@b.com", companyName: "TestCo", trialEndsAt: threeDaysOut },
          { id: "acc_2", email: "c@d.com", companyName: "Co2", trialEndsAt: threeDaysOut },
        ])
        .mockResolvedValueOnce([]);

      (sendEmail as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("SMTP down"))
        .mockResolvedValueOnce({ ok: true });

      const result = await sendTrialWarningEmails();

      // First email failed, second succeeded
      expect(result.sent3Day).toBe(1);
    });

    it("returns zero when no accounts are nearing expiry", async () => {
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await sendTrialWarningEmails();

      expect(result.sent3Day).toBe(0);
      expect(result.sent1Day).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe("cleanupExpiredTrialData", () => {
    it("soft-deletes trial accounts expired 60+ days ago", async () => {
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "acc_old" }]);
      (prismaAdmin.account.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await cleanupExpiredTrialData();

      expect(result.deleted).toBe(1);
      expect(prismaAdmin.account.update).toHaveBeenCalledWith({
        where: { id: "acc_old" },
        data: { status: "deleted" },
      });
    });

    it("returns zero when no accounts need cleanup", async () => {
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await cleanupExpiredTrialData();

      expect(result.deleted).toBe(0);
      expect(prismaAdmin.account.update).not.toHaveBeenCalled();
    });

    it("handles multiple accounts for deletion", async () => {
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "acc_1" },
        { id: "acc_2" },
        { id: "acc_3" },
      ]);
      (prismaAdmin.account.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await cleanupExpiredTrialData();

      expect(result.deleted).toBe(3);
      expect(prismaAdmin.account.update).toHaveBeenCalledTimes(3);
    });
  });
});
