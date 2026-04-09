/**
 * auth.service tests
 *
 * Mocks (1 — external boundary only):
 *   1. auth.client (erpLogin) — external ERPNext HTTP API
 *
 * Internal modules running for real:
 *   - bcrypt (real hashing — tests actual password verification)
 *   - logger (suppressed in test)
 *   - prismaAdmin mock for DB lookups
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/auth.client.js", () => ({
  erpLogin: vi.fn(),
}));
vi.mock("../../data/prisma-admin.js", () => ({
  prismaAdmin: { user: { findFirst: vi.fn().mockResolvedValue(null) } },
}));
// Logger: suppress output
vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

import { hashPassword, verifyPassword, login } from "../auth.service.js";
import { erpLogin } from "../../data/auth.client.js";

describe("auth.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("hashPassword", () => {
    it("returns a bcrypt hash", async () => {
      const hash = await hashPassword("testpassword");
      expect(hash).toMatch(/^\$2[aby]?\$/);
    });

    it("produces different hashes for same password (salted)", async () => {
      const h1 = await hashPassword("same");
      const h2 = await hashPassword("same");
      expect(h1).not.toBe(h2);
    });
  });

  describe("verifyPassword", () => {
    it("returns true for matching password", async () => {
      const hash = await hashPassword("correct");
      expect(await verifyPassword("correct", hash)).toBe(true);
    });

    it("returns false for wrong password", async () => {
      const hash = await hashPassword("correct");
      expect(await verifyPassword("wrong", hash)).toBe(false);
    });

    it("rejects legacy SHA-256 hashes", async () => {
      const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      expect(await verifyPassword("anything", sha256)).toBe(false);
    });
  });

  describe("login", () => {
    it("returns error for empty email", async () => {
      const result = await login("", "pass");
      expect(result.ok).toBe(false);
    });

    it("returns error for invalid email", async () => {
      const result = await login("notanemail", "pass");
      expect(result.ok).toBe(false);
    });

    it("returns error for empty password", async () => {
      const result = await login("test@test.com", "");
      expect(result.ok).toBe(false);
    });

    it("returns error for whitespace-only password", async () => {
      const result = await login("test@test.com", "   ");
      expect(result.ok).toBe(false);
    });

    it("returns ok on successful ERPNext login (no local user)", async () => {
      const { prismaAdmin } = await import("../../data/prisma-admin.js");
      vi.mocked(prismaAdmin.user.findFirst).mockResolvedValue(null);
      vi.mocked(erpLogin).mockResolvedValue({ ok: true, data: "session-id" });
      const result = await login("test@test.com", "password123");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe("session-id");
    });

    it("returns error on ERPNext failure when no local user", async () => {
      const { prismaAdmin } = await import("../../data/prisma-admin.js");
      vi.mocked(prismaAdmin.user.findFirst).mockResolvedValue(null);
      vi.mocked(erpLogin).mockResolvedValue({ ok: false, error: "Invalid credentials" });
      const result = await login("test@test.com", "wrong");
      expect(result.ok).toBe(false);
    });

    it("trims email before login", async () => {
      const { prismaAdmin } = await import("../../data/prisma-admin.js");
      vi.mocked(prismaAdmin.user.findFirst).mockResolvedValue(null);
      vi.mocked(erpLogin).mockResolvedValue({ ok: true, data: "sid" });
      await login("  test@test.com  ", "pass");
      expect(erpLogin).toHaveBeenCalledWith("test@test.com", "pass");
    });

    it("verifies local bcrypt hash before falling back to ERPNext", async () => {
      const { hashPassword } = await import("../auth.service.js");
      const hash = await hashPassword("correctpassword");
      const { prismaAdmin } = await import("../../data/prisma-admin.js");
      vi.mocked(prismaAdmin.user.findFirst).mockResolvedValue({ passwordHash: hash } as never);
      const result = await login("test@test.com", "correctpassword");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe("dev-local-session");
      // Should NOT call ERPNext when local password matches
      expect(erpLogin).not.toHaveBeenCalled();
    });

    it("returns error for wrong password when local user exists", async () => {
      const { hashPassword } = await import("../auth.service.js");
      const hash = await hashPassword("correctpassword");
      const { prismaAdmin } = await import("../../data/prisma-admin.js");
      vi.mocked(prismaAdmin.user.findFirst).mockResolvedValue({ passwordHash: hash } as never);
      const result = await login("test@test.com", "wrongpassword");
      expect(result.ok).toBe(false);
      // Should NOT fall through to ERPNext if local user exists
      expect(erpLogin).not.toHaveBeenCalled();
    });
  });
});
