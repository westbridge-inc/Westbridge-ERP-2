import { describe, it, expect, vi, beforeEach } from "vitest";

// invite.service is dual-import (v3.0): createInvite uses `prisma`
// because POST /invite is authenticated, while validateInviteToken
// and acceptInvite use `prismaAdmin` because GET /invite and POST
// /invite/accept are unauthenticated token redemption flows. The test
// mocks both modules and points them at the SAME mock object via
// vi.hoisted, so assertions on either client name see the same spies.
const { sharedMock } = vi.hoisted(() => ({
  sharedMock: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    inviteToken: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  } as Record<string, unknown>,
}));

vi.mock("../../data/prisma.js", () => ({ prisma: sharedMock }));
vi.mock("../../data/prisma-admin.js", () => ({ prismaAdmin: sharedMock }));
vi.mock("../../email/index.js", () => ({
  sendEmail: vi.fn(),
}));
vi.mock("../../email/templates.js", () => ({
  inviteEmail: vi.fn(() => "<html>invite</html>"),
}));

import { createInvite, validateInviteToken } from "../invite.service.js";
import { prismaAdmin } from "../../data/prisma-admin.js";
import { sendEmail } from "../../email/index.js";

describe("invite.service", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("createInvite", () => {
    it("returns error if user already has active account", async () => {
      vi.mocked(prismaAdmin.user.findUnique).mockResolvedValue({ status: "active" } as never);
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
      vi.mocked(prismaAdmin.user.findUnique).mockResolvedValue(null);
      vi.mocked(prismaAdmin.$transaction).mockResolvedValue({ id: "inv1" } as never);
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
      vi.mocked(prismaAdmin.user.findUnique).mockResolvedValue(null);
      vi.mocked(prismaAdmin.$transaction).mockResolvedValue({ id: "inv1" } as never);
      vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: "SMTP down" });
      vi.mocked(prismaAdmin.inviteToken.delete).mockResolvedValue({} as never);
      const r = await createInvite({
        accountId: "acc1",
        email: "new@test.com",
        role: "member",
        inviterName: "Boss",
        companyName: "Co",
        baseUrl: "https://app.com",
      });
      expect(r.ok).toBe(false);
      expect(prismaAdmin.inviteToken.delete).toHaveBeenCalled();
    });
  });

  describe("validateInviteToken", () => {
    it("returns error for unknown token", async () => {
      vi.mocked(prismaAdmin.inviteToken.findUnique).mockResolvedValue(null);
      const r = await validateInviteToken("badtoken");
      expect(r.ok).toBe(false);
    });

    it("returns error for used token", async () => {
      vi.mocked(prismaAdmin.inviteToken.findUnique).mockResolvedValue({
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 999999),
      } as never);
      const r = await validateInviteToken("usedtoken");
      expect(r.ok).toBe(false);
    });

    it("returns error for expired token", async () => {
      vi.mocked(prismaAdmin.inviteToken.findUnique).mockResolvedValue({
        usedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      } as never);
      const r = await validateInviteToken("expired");
      expect(r.ok).toBe(false);
    });

    it("returns ok for valid token", async () => {
      vi.mocked(prismaAdmin.inviteToken.findUnique).mockResolvedValue({
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
