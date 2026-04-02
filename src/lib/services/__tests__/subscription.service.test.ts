import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma.js", () => ({
  prisma: {
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
} from "../subscription.service.js";
import { prisma } from "../../data/prisma.js";
import { cancelPaddleSubscription } from "../../data/paddle.client.js";

describe("subscription.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSubscription", () => {
    it("creates subscription and invoice", async () => {
      (prisma.subscription.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "sub_1" });
      (prisma.billingInvoice.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv_1" });

      const result = await createSubscription("acc_1", "Starter");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.subscriptionId).toBe("sub_1");
    });

    it("handles errors", async () => {
      (prisma.subscription.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db err"));

      const result = await createSubscription("acc_1", "Starter");
      expect(result.ok).toBe(false);
    });
  });

  describe("handleRenewal", () => {
    it("extends subscription when active sub exists", async () => {
      (prisma.subscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "sub_1",
        planId: "Starter",
      });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await handleRenewal("acc_1", "txn_1", "paddle_sub_1");
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("logs warning when no active subscription found", async () => {
      (prisma.subscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await handleRenewal("acc_1", "txn_1");
      // Should not throw
    });
  });

  describe("checkGracePeriodExpiry", () => {
    it("marks expired subscriptions as past_due", async () => {
      (prisma.subscription.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
      (prisma.subscription.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { accountId: "acc_1" },
        { accountId: "acc_2" },
      ]);
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

      const result = await checkGracePeriodExpiry();
      expect(result.updated).toBe(2);
    });
  });

  describe("extendSubscription", () => {
    it("extends subscription period", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await extendSubscription("sub_1", "Starter", "acc_1");
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("updates invoice when transactionId provided", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.billingInvoice.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await extendSubscription("sub_1", "Starter", "acc_1", "txn_1", "rrn_1");
      expect(prisma.billingInvoice.updateMany).toHaveBeenCalled();
    });
  });

  describe("changePlan", () => {
    it("changes plan successfully", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await changePlan("acc_1", "Business");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.message).toContain("Business");
    });

    it("returns error for invalid plan", async () => {
      const result = await changePlan("acc_1", "InvalidPlan");
      expect(result.ok).toBe(false);
    });

    it("handles errors", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db err"));

      const result = await changePlan("acc_1", "Business");
      expect(result.ok).toBe(false);
    });
  });

  describe("cancelSubscription", () => {
    it("cancels subscription", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await cancelSubscription("acc_1");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.message).toContain("canceled");
    });

    it("cancels on Paddle when subscription ID provided", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await cancelSubscription("acc_1", "paddle_sub_123");
      expect(result.ok).toBe(true);
      expect(cancelPaddleSubscription).toHaveBeenCalledWith("paddle_sub_123");
    });

    it("handles errors", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db err"));

      const result = await cancelSubscription("acc_1");
      expect(result.ok).toBe(false);
    });
  });
});
