import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma.js", () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
    },
    passwordResetToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: "prt_1" }),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../../email/index.js", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, data: { id: "e1" } }),
}));

vi.mock("../../email/templates.js", () => ({
  passwordResetEmail: vi.fn().mockReturnValue("<p>reset</p>"),
}));

import { requestPasswordReset, applyPasswordReset } from "../password-reset.service.js";
import { prisma } from "../../data/prisma.js";

describe("password-reset.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("requestPasswordReset", () => {
    it("returns ok even when user not found (prevents enumeration)", async () => {
      (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await requestPasswordReset("nonexistent@test.com", "http://localhost:3000");
      expect(result.ok).toBe(true);
    });

    it("sends reset email when user found", async () => {
      (prisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "usr_1",
        email: "user@test.com",
        name: "Test User",
        account: { companyName: "Test Co" },
      });

      const result = await requestPasswordReset("user@test.com", "http://localhost:3000");
      expect(result.ok).toBe(true);
    });
  });

  describe("applyPasswordReset", () => {
    it("returns error for invalid token", async () => {
      // passwordResetToken.findUnique returns null for unknown token hash
      (prisma.passwordResetToken as any).findUnique = vi.fn().mockResolvedValue(null);

      const result = await applyPasswordReset({ raw: "some-invalid-token", newPassword: "NewPassword123!" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Invalid");
    });
  });
});
