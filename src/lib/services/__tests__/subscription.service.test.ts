import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma.js", () => ({
  prisma: {
    subscription: {
      create: vi.fn(),
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

vi.mock("../../data/twocheckout.client.js", () => ({
  createPaymentSession: vi.fn(),
}));

vi.mock("../../email/index.js", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createSubscription,
  processMonthlyRenewals,
  extendSubscription,
  changePlan,
  cancelSubscription,
} from "../subscription.service.js";
import { prisma } from "../../data/prisma.js";

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

  describe("processMonthlyRenewals", () => {
    it("processes due subscriptions", async () => {
      (prisma.subscription.findMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([]) // dueSubscriptions
        .mockResolvedValueOnce([]); // pastDueSubs
      (prisma.subscription.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      const stats = await processMonthlyRenewals();
      expect(stats.processed).toBe(0);
      expect(stats.succeeded).toBe(0);
      expect(stats.failed).toBe(0);
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

    it("handles errors", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db err"));

      const result = await cancelSubscription("acc_1");
      expect(result.ok).toBe(false);
    });
  });
});
