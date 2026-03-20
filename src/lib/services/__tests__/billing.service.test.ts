import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma.js", () => ({
  prisma: {
    account: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../../data/twocheckout.client.js", () => ({
  createPaymentSession: vi.fn(),
  isPaymentApproved: vi.fn(),
  verifyCallbackSignature: vi.fn(),
}));

vi.mock("../../utils/result.js", async () => {
  const actual = await vi.importActual("../../utils/result.js");
  return actual;
});

vi.mock("../../email/index.js", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, data: { id: "e1" } }),
}));

vi.mock("../../email/templates.js", () => ({
  accountActivatedEmail: vi.fn().mockReturnValue("<p>activated</p>"),
}));

vi.mock("../provisioning.service.js", () => ({
  provisionErpnextAccount: vi.fn().mockResolvedValue({ ok: true }),
  provisionWithRetry: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../subscription.service.js", () => ({
  createSubscription: vi.fn().mockResolvedValue({ ok: true }),
}));

import { createAccount, verifyPaymentCallback, isPaymentSuccess, markAccountPaid } from "../billing.service.js";
import { prisma } from "../../data/prisma.js";
import { verifyCallbackSignature, isPaymentApproved } from "../../data/twocheckout.client.js";

describe("billing.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createAccount", () => {
    it("returns error for missing fields", async () => {
      const result = await createAccount({ email: "", companyName: "", plan: "" }, "http://localhost");
      expect(result.ok).toBe(false);
    });

    it("returns error for invalid plan", async () => {
      const result = await createAccount(
        { email: "a@b.com", companyName: "Test", plan: "InvalidPlan" },
        "http://localhost",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Invalid plan");
    });

    it("creates account with valid input", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: Function) => {
        return fn({
          account: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "acc_1", email: "a@b.com" }),
            delete: vi.fn(),
          },
        });
      });
      const { createPaymentSession } = await import("../../data/twocheckout.client.js");
      (createPaymentSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await createAccount(
        { email: "a@b.com", companyName: "Test Co", plan: "Starter" },
        "http://localhost:3000",
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("verifyPaymentCallback", () => {
    it("delegates to verifyCallbackSignature", () => {
      (verifyCallbackSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);
      expect(verifyPaymentCallback("body", "sig")).toBe(true);
    });
  });

  describe("isPaymentSuccess", () => {
    it("delegates to isPaymentApproved", () => {
      (isPaymentApproved as ReturnType<typeof vi.fn>).mockReturnValue(true);
      expect(isPaymentSuccess({ ORDERSTATUS: "COMPLETE" })).toBe(true);
    });

    it("returns false for failed payment", () => {
      (isPaymentApproved as ReturnType<typeof vi.fn>).mockReturnValue(false);
      expect(isPaymentSuccess({ ORDERSTATUS: "PENDING" })).toBe(false);
    });
  });

  describe("markAccountPaid", () => {
    it("activates account on payment", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "acc_1",
        email: "a@b.com",
        companyName: "Test",
        plan: "Starter",
      });

      const result = await markAccountPaid("acc_1", "txn_1", "rrn_1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.updated).toBe(true);
      }
    });

    it("handles no account found", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      const result = await markAccountPaid("acc_missing");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.updated).toBe(false);
      }
    });

    it("returns error on exception", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db error"));

      const result = await markAccountPaid("acc_1");
      expect(result.ok).toBe(false);
    });
  });
});
