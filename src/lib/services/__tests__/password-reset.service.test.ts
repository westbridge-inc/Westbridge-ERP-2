import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../data/prisma-admin.js", () => ({
  prismaAdmin: {
    user: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    passwordResetToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: "prt_1" }),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    session: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../../email/index.js", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, data: { id: "e1" } }),
}));

vi.mock("../../email/templates.js", () => ({
  passwordResetEmail: vi.fn().mockReturnValue("<p>reset</p>"),
}));

// Mock auth.service.hashPassword to a deterministic value so we can assert
// the local hash is overwritten on reset.
vi.mock("../auth.service.js", () => ({
  hashPassword: vi.fn().mockResolvedValue("$2b$14$NEW_HASH_FOR_NewPassword123!"),
}));

// Mock the global fetch ERPNext call so applyPasswordReset's HTTP step
// returns a success response without needing a real ERPNext instance.
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => "{}",
    json: async () => ({ message: "ok" }),
  } as unknown as Response);
});

import { requestPasswordReset, applyPasswordReset } from "../password-reset.service.js";
import { prismaAdmin } from "../../data/prisma-admin.js";

describe("password-reset.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("requestPasswordReset", () => {
    it("returns ok even when user not found (prevents enumeration)", async () => {
      (prismaAdmin.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await requestPasswordReset("nonexistent@test.com", "http://localhost:3000");
      expect(result.ok).toBe(true);
    });

    it("sends reset email when user found", async () => {
      (prismaAdmin.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
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
      (prismaAdmin.passwordResetToken as any).findUnique = vi.fn().mockResolvedValue(null);

      const result = await applyPasswordReset({ raw: "some-invalid-token", newPassword: "NewPassword123!" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Invalid");
    });

    // Regression test for audit finding C2 (2026-04-09): applyPasswordReset
    // used to update the password in ERPNext but never wrote
    // prismaAdmin.user.passwordHash. The login flow checks the local hash first
    // and short-circuits, so the OLD password kept working AND the NEW
    // password could not authenticate. The fix adds a passwordHash write
    // inside the post-ERPNext transaction; this test asserts that.
    it("writes the new bcrypt hash to user.passwordHash on success (C2 regression)", async () => {
      const fakeToken = {
        id: "prt_1",
        userId: "usr_1",
        tokenHash: "abc",
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: "usr_1", email: "user@test.com" },
      };
      (prismaAdmin.passwordResetToken as any).findUnique = vi.fn().mockResolvedValue(fakeToken);

      // Capture the operations passed into prismaAdmin.$transaction so we can
      // assert that user.update was called with passwordHash set.
      const transactionCalls: Array<{ table: string; data?: Record<string, unknown> }> = [];
      (prismaAdmin as any).$transaction = vi.fn().mockImplementation(async (ops: unknown[]) => {
        // The mock prismaAdmin.user.update / passwordResetToken.update / session.deleteMany
        // each return a thenable promise; record what they were called with.
        return ops;
      });
      // Re-mock the inner ops so they record their args.
      (prismaAdmin.user as any).update = vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        transactionCalls.push({ table: "user", data: args.data });
        return Promise.resolve(args);
      });
      (prismaAdmin.passwordResetToken as any).update = vi
        .fn()
        .mockImplementation((args: { data: Record<string, unknown> }) => {
          transactionCalls.push({ table: "passwordResetToken", data: args.data });
          return Promise.resolve(args);
        });
      (prismaAdmin.session as any).deleteMany = vi
        .fn()
        .mockImplementation((args: { where: Record<string, unknown> }) => {
          transactionCalls.push({ table: "session", data: args.where });
          return Promise.resolve({ count: 1 });
        });

      const result = await applyPasswordReset({ raw: "valid-raw-token", newPassword: "NewPassword123!" });

      expect(result.ok).toBe(true);

      // The fix is here: user.update MUST receive a passwordHash field.
      // Before the fix, user.update was called only with failedLoginAttempts /
      // lockedUntil / passwordChangedAt — never with passwordHash. That bug
      // is exactly what allowed the old password to keep authenticating.
      const userUpdate = transactionCalls.find((c) => c.table === "user");
      expect(userUpdate).toBeDefined();
      expect(userUpdate?.data).toMatchObject({
        passwordHash: "$2b$14$NEW_HASH_FOR_NewPassword123!",
        failedLoginAttempts: 0,
        lockedUntil: null,
      });

      // Sessions must be revoked on a password change so any stolen tokens
      // become invalid (defence in depth alongside the hash update).
      const sessionDelete = transactionCalls.find((c) => c.table === "session");
      expect(sessionDelete).toBeDefined();
      expect(sessionDelete?.data).toMatchObject({ userId: "usr_1" });
    });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
