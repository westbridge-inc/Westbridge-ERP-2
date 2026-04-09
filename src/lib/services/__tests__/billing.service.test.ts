/**
 * billing.service tests
 *
 * Mocks (4 — external boundaries only):
 *   1. prisma                — database
 *   2. paddle.client         — external payment API
 *   3. email/index           — Resend email API
 *   4. provisioning.service  — ERPNext provisioning (external API)
 *
 * Internal modules running for real:
 *   - result.js (ok/err utilities)
 *   - email/templates.js (pure string templates)
 *   - subscription.service (mocked since it writes to DB)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma.js", () => ({
  prisma: {
    account: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    subscription: { create: vi.fn(), updateMany: vi.fn() },
    billingInvoice: { create: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("../../data/paddle.client.js", () => ({
  verifyWebhookSignature: vi.fn(),
}));

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

vi.mock("../../realtime.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../auth.service.js", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password"),
}));

vi.mock("../session.service.js", () => ({
  createSession: vi.fn().mockResolvedValue({ ok: true, data: { token: "session-token" } }),
}));

import { createAccount, verifyPaddleWebhook, markAccountPaid, refundWindowDaysFor } from "../billing.service.js";
import { prisma } from "../../data/prisma.js";
import { verifyWebhookSignature } from "../../data/paddle.client.js";

describe("billing.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createAccount", () => {
    const validInput = {
      email: "a@b.com",
      name: "Test User",
      password: "password123",
      companyName: "Test Co",
      plan: "Starter",
    };

    it("returns error for missing fields", async () => {
      const result = await createAccount({ email: "", name: "", password: "", companyName: "", plan: "" });
      expect(result.ok).toBe(false);
    });

    it("returns error for invalid plan", async () => {
      const result = await createAccount({ ...validInput, plan: "InvalidPlan" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Invalid plan");
    });

    it("validates email is not empty whitespace", async () => {
      const result = await createAccount({ ...validInput, email: "  " });
      expect(result.ok).toBe(false);
    });

    it("validates companyName is not empty whitespace", async () => {
      const result = await createAccount({ ...validInput, companyName: "  " });
      expect(result.ok).toBe(false);
    });

    it("validates password minimum length", async () => {
      const result = await createAccount({ ...validInput, password: "short" });
      expect(result.ok).toBe(false);
    });

    // Regression: new trial accounts must auto-provision an ERPNext company +
    // subscription immediately on signup. Without this, trial users share an
    // unscoped ERPNext instance (cross-tenant data leak) until they pay.
    it("triggers ERPNext provisioning and subscription creation on successful signup", async () => {
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn) => {
        const tx = {
          account: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({
              id: "acc_new",
              email: "new@b.com",
              companyName: "New Co",
              plan: "Starter",
            }),
          },
          user: {
            create: vi.fn().mockResolvedValue({
              id: "user_new",
              accountId: "acc_new",
              email: "new@b.com",
              name: "New User",
            }),
          },
          $executeRaw: vi.fn(),
        };
        return fn(tx);
      });

      const result = await createAccount({
        email: "new@b.com",
        name: "New User",
        password: "password123",
        companyName: "New Co",
        plan: "Starter",
      });

      expect(result.ok).toBe(true);

      // Wait a tick so the fire-and-forget imports resolve
      await new Promise((r) => setTimeout(r, 10));

      const { provisionWithRetry } = await import("../provisioning.service.js");
      const { createSubscription } = await import("../subscription.service.js");
      expect(provisionWithRetry).toHaveBeenCalledWith("acc_new");
      expect(createSubscription).toHaveBeenCalledWith("acc_new", "Starter");
    });
  });

  describe("verifyPaddleWebhook", () => {
    it("delegates to verifyWebhookSignature", () => {
      (verifyWebhookSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);
      expect(verifyPaddleWebhook('{"event":"test"}', "ts=123;h1=abc")).toBe(true);
    });

    it("returns false for invalid signature", () => {
      (verifyWebhookSignature as ReturnType<typeof vi.fn>).mockReturnValue(false);
      expect(verifyPaddleWebhook('{"event":"test"}', "ts=123;h1=bad")).toBe(false);
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

      const result = await markAccountPaid("acc_1", "txn_1", "sub_1");
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

  // ─── Refund window branching (B5: align with published policy) ─────────
  //
  // The published Refund Policy table:
  //
  //   First monthly subscription          → 14 days, 100% refund
  //   Monthly subscription renewals       → not eligible
  //   Annual subscription (first-time)    → 30 days, pro-rata
  //   Annual subscription renewals        → 14 days, pro-rata
  //
  // Pre-fix the code hardcoded `REFUND_WINDOW_DAYS = 14` for every invoice
  // type, so a customer who paid for an annual plan and asked for a refund
  // on day 20 was rejected even though the policy promised 30 days. The
  // refundWindowDaysFor() helper now branches on (annual?, first-time?).
  describe("refundWindowDaysFor", () => {
    const monthly = {
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-02-01"), // 31 days
    };
    const annual = {
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2027-01-01"), // 365 days
    };

    it("first-time monthly → 14-day window", () => {
      expect(refundWindowDaysFor(monthly, 0)).toBe(14);
    });

    it("monthly renewal → 0 days (not eligible per policy)", () => {
      expect(refundWindowDaysFor(monthly, 1)).toBe(0);
      expect(refundWindowDaysFor(monthly, 5)).toBe(0);
    });

    it("first-time annual → 30-day window", () => {
      expect(refundWindowDaysFor(annual, 0)).toBe(30);
    });

    it("annual renewal → 14-day window", () => {
      expect(refundWindowDaysFor(annual, 1)).toBe(14);
      expect(refundWindowDaysFor(annual, 12)).toBe(14);
    });

    it("classifies a 30-day period as monthly, not annual", () => {
      const thirty = { periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31") };
      expect(refundWindowDaysFor(thirty, 0)).toBe(14); // monthly first-time
    });

    it("classifies a 365-day period as annual, not monthly", () => {
      // Defensive: 180-day threshold means anything > 180 days is annual.
      // A 365-day period is unambiguously annual.
      expect(refundWindowDaysFor(annual, 0)).toBe(30);
    });
  });
});
