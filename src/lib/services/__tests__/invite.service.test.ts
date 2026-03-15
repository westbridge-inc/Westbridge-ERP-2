import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    inviteToken: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));
vi.mock("../../email/index.js", () => ({
  sendEmail: vi.fn(),
}));
vi.mock("../../email/templates.js", () => ({
  inviteEmail: vi.fn(() => "<html>invite</html>"),
}));

import { createInvite, validateInviteToken, acceptInvite } from "../invite.service.js";
import { prisma } from "../../data/prisma.js";
import { sendEmail } from "../../email/index.js";

describe("invite.service", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("createInvite", () => {
    it("returns error if user already has active account", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ status: "active" } as never);
      const r = await createInvite({
        accountId: "acc1",
        email: "test@test.com",
        role: "member",
        inviterName: "Boss",
        companyName: "Co",
        baseUrl: "https://app.com",
      });
      expect(r.ok).toBe(false);
    });

    it("creates invite and sends email on success", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.$transaction).mockResolvedValue({ id: "inv1" } as never);
      vi.mocked(sendEmail).mockResolvedValue({ ok: true, data: { id: "sent" } });
      const r = await createInvite({
        accountId: "acc1",
        email: "new@test.com",
        role: "member",
        inviterName: "Boss",
        companyName: "Co",
        baseUrl: "https://app.com",
      });
      expect(r.ok).toBe(true);
    });

    it("rolls back invite if email fails", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.$transaction).mockResolvedValue({ id: "inv1" } as never);
      vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: "SMTP down" });
      vi.mocked(prisma.inviteToken.delete).mockResolvedValue({} as never);
      const r = await createInvite({
        accountId: "acc1",
        email: "new@test.com",
        role: "member",
        inviterName: "Boss",
        companyName: "Co",
        baseUrl: "https://app.com",
      });
      expect(r.ok).toBe(false);
      expect(prisma.inviteToken.delete).toHaveBeenCalled();
    });
  });

  describe("validateInviteToken", () => {
    it("returns error for unknown token", async () => {
      vi.mocked(prisma.inviteToken.findUnique).mockResolvedValue(null);
      const r = await validateInviteToken("badtoken");
      expect(r.ok).toBe(false);
    });

    it("returns error for used token", async () => {
      vi.mocked(prisma.inviteToken.findUnique).mockResolvedValue({
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 999999),
      } as never);
      const r = await validateInviteToken("usedtoken");
      expect(r.ok).toBe(false);
    });

    it("returns error for expired token", async () => {
      vi.mocked(prisma.inviteToken.findUnique).mockResolvedValue({
        usedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      } as never);
      const r = await validateInviteToken("expired");
      expect(r.ok).toBe(false);
    });

    it("returns ok for valid token", async () => {
      vi.mocked(prisma.inviteToken.findUnique).mockResolvedValue({
        id: "inv1",
        accountId: "acc1",
        email: "test@test.com",
        role: "member",
        usedAt: null,
        expiresAt: new Date(Date.now() + 999999),
      } as never);
      const r = await validateInviteToken("validtoken");
      expect(r.ok).toBe(true);
    });
  });
});
