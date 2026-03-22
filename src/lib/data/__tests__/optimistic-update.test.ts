import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    account: {
      updateMany: vi.fn(),
    },
    user: {
      updateMany: vi.fn(),
    },
  },
}));

import { optimisticUpdate } from "../optimistic-update.js";
import { prisma } from "../prisma.js";

describe("optimistic-update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("optimisticUpdate — account model", () => {
    it("returns ok with incremented version on successful update", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const result = await optimisticUpdate("account", "acc_1", 3, { plan: "Business" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.version).toBe(4);
      }
    });

    it("calls prisma.account.updateMany with correct where and data", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await optimisticUpdate("account", "acc_1", 5, { plan: "Enterprise" });

      expect(prisma.account.updateMany).toHaveBeenCalledWith({
        where: { id: "acc_1", version: 5 },
        data: { plan: "Enterprise", version: { increment: 1 } },
      });
    });

    it("returns error when count is 0 (concurrent modification)", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      const result = await optimisticUpdate("account", "acc_1", 3, { plan: "Business" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Concurrent modification");
      }
    });

    it("does not call prisma.user.updateMany for account model", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await optimisticUpdate("account", "acc_1", 1, { companyName: "New Name" });

      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("optimisticUpdate — user model", () => {
    it("returns ok with incremented version on successful update", async () => {
      (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const result = await optimisticUpdate("user", "usr_1", 7, { name: "Updated" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.version).toBe(8);
      }
    });

    it("calls prisma.user.updateMany with correct where and data", async () => {
      (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await optimisticUpdate("user", "usr_1", 2, { name: "Jane", role: "admin" });

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "usr_1", version: 2 },
        data: { name: "Jane", role: "admin", version: { increment: 1 } },
      });
    });

    it("returns error when count is 0 (concurrent modification)", async () => {
      (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      const result = await optimisticUpdate("user", "usr_1", 10, { name: "X" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Concurrent modification");
      }
    });

    it("does not call prisma.account.updateMany for user model", async () => {
      (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await optimisticUpdate("user", "usr_1", 1, { name: "Test" });

      expect(prisma.account.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("handles version 0 correctly", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const result = await optimisticUpdate("account", "acc_1", 0, { plan: "Solo" });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.version).toBe(1);
    });

    it("handles empty data object", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      const result = await optimisticUpdate("account", "acc_1", 5, {});

      expect(result.ok).toBe(true);
      expect(prisma.account.updateMany).toHaveBeenCalledWith({
        where: { id: "acc_1", version: 5 },
        data: { version: { increment: 1 } },
      });
    });

    it("handles multiple fields in update data", async () => {
      (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await optimisticUpdate("user", "usr_1", 3, { name: "John", role: "admin", email: "j@test.com" });

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "usr_1", version: 3 },
        data: { name: "John", role: "admin", email: "j@test.com", version: { increment: 1 } },
      });
    });

    it("preserves version increment even with version in data", async () => {
      (prisma.account.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      // If someone passes version in data, it gets overwritten by { increment: 1 }
      await optimisticUpdate("account", "acc_1", 5, { version: 999 } as any);

      const call = (prisma.account.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.data.version).toEqual({ increment: 1 });
    });
  });
});
