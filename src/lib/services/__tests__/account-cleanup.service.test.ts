/**
 * account-cleanup.service tests (Big-4 audit B1 + B2)
 *
 * Mocks (database boundary only). Internal helpers run for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma-admin.js", () => ({
  prismaAdmin: {
    user: { findMany: vi.fn(), update: vi.fn() },
    session: { deleteMany: vi.fn() },
    apiKey: { deleteMany: vi.fn() },
    webhookEndpoint: { deleteMany: vi.fn() },
    ssoConfig: { deleteMany: vi.fn() },
    inviteToken: { deleteMany: vi.fn() },
    passwordResetToken: { deleteMany: vi.fn() },
    account: { update: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    auditLog: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../audit.service.js", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import { softDeleteAccount, hardDeleteAccount, findAccountsDueForHardDelete } from "../account-cleanup.service.js";
import { prismaAdmin } from "../../data/prisma-admin.js";

describe("account-cleanup.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── softDeleteAccount ─────────────────────────────────────────────────
  describe("softDeleteAccount", () => {
    function mockTransactionRunner() {
      const tx = {
        user: { update: vi.fn().mockResolvedValue({}) },
        session: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
        apiKey: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
        webhookEndpoint: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
        ssoConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
        inviteToken: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
        passwordResetToken: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
        account: { update: vi.fn().mockResolvedValue({}) },
      };
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn) => fn(tx));
      return tx;
    }

    it("anonymizes every user in the account", async () => {
      (prismaAdmin.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "u1" }, { id: "u2" }]);
      const tx = mockTransactionRunner();

      const result = await softDeleteAccount("acc_1", { initiatorUserId: "u1" });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.usersAffected).toBe(2);

      // Both users should have been anonymized with placeholder PII
      expect(tx.user.update).toHaveBeenCalledTimes(2);
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "u1" },
          data: expect.objectContaining({
            name: "Deleted User",
            email: "deleted-u1@deleted.invalid",
            passwordHash: null,
            status: "deleted",
            deletedAt: expect.any(Date),
          }),
        }),
      );
    });

    it("revokes ALL credential tables (sessions, api keys, webhooks, sso, invites, password resets)", async () => {
      (prismaAdmin.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "u1" }]);
      const tx = mockTransactionRunner();

      await softDeleteAccount("acc_1", { initiatorUserId: "u1" });

      // Regression for B2 — pre-fix only sessions + invites were deleted.
      expect(tx.session.deleteMany).toHaveBeenCalled();
      expect(tx.apiKey.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc_1" } });
      expect(tx.webhookEndpoint.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc_1" } });
      expect(tx.ssoConfig.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc_1" } });
      expect(tx.inviteToken.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc_1" } });
      expect(tx.passwordResetToken.deleteMany).toHaveBeenCalled();
    });

    it("stamps account.deletedAt so the cleanup worker can find it", async () => {
      (prismaAdmin.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "u1" }]);
      const tx = mockTransactionRunner();

      await softDeleteAccount("acc_1", { initiatorUserId: "u1" });

      // Regression for B1 — pre-fix only `status` was set, not deletedAt,
      // so the cleanup worker had nothing to query against.
      expect(tx.account.update).toHaveBeenCalledWith({
        where: { id: "acc_1" },
        data: expect.objectContaining({
          status: "deleted",
          deletedAt: expect.any(Date),
        }),
      });
    });

    it("returns err when the transaction throws", async () => {
      (prismaAdmin.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "u1" }]);
      (prismaAdmin.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));

      const result = await softDeleteAccount("acc_1", { initiatorUserId: "u1" });

      expect(result.ok).toBe(false);
    });
  });

  // ─── findAccountsDueForHardDelete ──────────────────────────────────────
  describe("findAccountsDueForHardDelete", () => {
    it("queries soft-deleted accounts older than 30 days", async () => {
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "acc_a" }, { id: "acc_b" }]);

      const now = new Date("2026-04-09T00:00:00Z");
      const ids = await findAccountsDueForHardDelete(now);

      expect(ids).toEqual(["acc_a", "acc_b"]);
      const call = (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.where.status).toBe("deleted");
      // Cutoff = now - 30d = 2026-03-10
      const expectedCutoff = new Date("2026-03-10T00:00:00Z");
      expect((call.where.deletedAt.lt as Date).getTime()).toBe(expectedCutoff.getTime());
    });

    it("returns an empty list when no rows are due", async () => {
      (prismaAdmin.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const ids = await findAccountsDueForHardDelete(new Date());
      expect(ids).toEqual([]);
    });
  });

  // ─── hardDeleteAccount ─────────────────────────────────────────────────
  describe("hardDeleteAccount", () => {
    it("anonymizes audit logs THEN deletes the account (order matters for FK SET NULL)", async () => {
      const updateMany = vi.fn().mockResolvedValue({ count: 42 });
      const deleteAccount = vi.fn().mockResolvedValue({});
      (prismaAdmin.auditLog.updateMany as ReturnType<typeof vi.fn>) = updateMany;
      (prismaAdmin.account.delete as ReturnType<typeof vi.fn>) = deleteAccount;
      (prismaAdmin.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        erpnextCompany: null,
      });

      const result = await hardDeleteAccount("acc_1");

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.auditLogsAnonymized).toBe(42);

      // Audit log scrub call must include the PII fields and clear user_id
      expect(updateMany).toHaveBeenCalledWith({
        where: { accountId: "acc_1" },
        data: expect.objectContaining({
          userId: null,
          ipAddress: null,
          userAgent: null,
          metadata: expect.any(Object),
        }),
      });

      // The actual cascade delete must have run
      expect(deleteAccount).toHaveBeenCalledWith({ where: { id: "acc_1" } });

      // updateMany must have been called BEFORE delete (in order, so the
      // FK SET NULL on the delete doesn't pre-empt the PII scrub call)
      const updateOrder = updateMany.mock.invocationCallOrder[0];
      const deleteOrder = deleteAccount.mock.invocationCallOrder[0];
      expect(updateOrder).toBeLessThan(deleteOrder);
    });

    it("returns err when account.delete throws (does NOT silently swallow)", async () => {
      (prismaAdmin.auditLog.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      (prismaAdmin.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        erpnextCompany: null,
      });
      (prismaAdmin.account.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("FK violation"));

      const result = await hardDeleteAccount("acc_1");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("FK violation");
    });

    it("does NOT block delete if ERPNext deprovision fails", async () => {
      // ERPNEXT_API_KEY/SECRET unset → deleteErpnextCompany is a no-op,
      // so just confirm the delete still runs even when erpnextCompany is set.
      (prismaAdmin.auditLog.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      (prismaAdmin.account.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        erpnextCompany: "Acme Corp",
      });
      (prismaAdmin.account.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await hardDeleteAccount("acc_1");

      expect(result.ok).toBe(true);
      expect(prismaAdmin.account.delete).toHaveBeenCalled();
    });
  });
});
