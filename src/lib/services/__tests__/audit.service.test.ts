/**
 * audit.service tests
 *
 * Mocks (2 — external boundaries only):
 *   1. prisma — database writes
 *   2. redis  — hash chain caching
 *
 * Internal modules running for real:
 *   - logger (runs but output is suppressed in test env)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma-admin.js", () => ({
  prismaAdmin: { auditLog: { create: vi.fn() } },
}));
vi.mock("../../redis.js", () => ({
  getRedis: vi.fn(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  })),
}));
// Logger: suppress output in tests but let the module load for real
vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { logAudit, safeLogAudit, rowToCsv, CSV_HEADER } from "../audit.service.js";
import { prismaAdmin } from "../../data/prisma-admin.js";

describe("audit.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("logAudit", () => {
    it("writes audit log to database", async () => {
      vi.mocked(prismaAdmin.auditLog.create).mockResolvedValue({} as never);
      await logAudit({
        accountId: "acc1",
        userId: "user1",
        action: "test.action",
        severity: "info",
        outcome: "success",
      });
      expect(prismaAdmin.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it("skips DB write for system events (null accountId)", async () => {
      await logAudit({ accountId: null, action: "system.boot" });
      expect(prismaAdmin.auditLog.create).not.toHaveBeenCalled();
    });

    it("redacts IP last octet", async () => {
      vi.mocked(prismaAdmin.auditLog.create).mockResolvedValue({} as never);
      await logAudit({
        accountId: "acc1",
        action: "test",
        ipAddress: "192.168.1.100",
      });
      const call = vi.mocked(prismaAdmin.auditLog.create).mock.calls[0][0];
      expect(call.data.ipAddress).toBe("192.168.1.0");
    });

    it("hashes user agent", async () => {
      vi.mocked(prismaAdmin.auditLog.create).mockResolvedValue({} as never);
      await logAudit({
        accountId: "acc1",
        action: "test",
        userAgent: "Mozilla/5.0",
      });
      const call = vi.mocked(prismaAdmin.auditLog.create).mock.calls[0][0];
      expect(call.data.userAgent).toHaveLength(16);
      expect(call.data.userAgent).not.toBe("Mozilla/5.0");
    });

    it("includes hash chain in metadata", async () => {
      vi.mocked(prismaAdmin.auditLog.create).mockResolvedValue({} as never);
      await logAudit({ accountId: "acc1", action: "test" });
      const call = vi.mocked(prismaAdmin.auditLog.create).mock.calls[0][0];
      const meta = call.data.metadata as Record<string, unknown>;
      expect(meta._hash).toBeDefined();
      expect(meta._prevHash).toBeDefined();
    });

    it("redacts sensitive metadata keys recursively", async () => {
      vi.mocked(prismaAdmin.auditLog.create).mockResolvedValue({} as never);
      await logAudit({
        accountId: "acc1",
        action: "test",
        meta: {
          safe: "visible",
          password: "should-be-redacted",
          nested: { secret_key: "also-redacted", visible: "ok" },
        },
      });
      const call = vi.mocked(prismaAdmin.auditLog.create).mock.calls[0][0];
      const meta = call.data.metadata as Record<string, unknown>;
      expect(meta.safe).toBe("visible");
      expect(meta.password).toBe("[REDACTED]");
      expect((meta.nested as Record<string, unknown>).secret_key).toBe("[REDACTED]");
      expect((meta.nested as Record<string, unknown>).visible).toBe("ok");
    });

    it("does not throw on DB error", async () => {
      vi.mocked(prismaAdmin.auditLog.create).mockRejectedValue(new Error("DB down"));
      await expect(logAudit({ accountId: "acc1", action: "test" })).resolves.toBeUndefined();
    });
  });

  describe("safeLogAudit", () => {
    it("does not throw even on error", () => {
      vi.mocked(prismaAdmin.auditLog.create).mockRejectedValue(new Error("fail"));
      expect(() => safeLogAudit({ accountId: "acc1", action: "test" })).not.toThrow();
    });
  });

  describe("rowToCsv", () => {
    it("formats a row as CSV", () => {
      const csv = rowToCsv({
        timestamp: new Date("2026-01-01T00:00:00Z"),
        action: "auth.login",
        userId: "u1",
        ipAddress: "1.2.3.0",
        severity: "info",
        outcome: "success",
        resource: null,
        resourceId: null,
        metadata: { key: "val" },
      });
      expect(csv).toContain("auth.login");
      expect(csv).toContain("2026-01-01");
      expect(csv.endsWith("\n")).toBe(true);
    });

    it("escapes quotes in values", () => {
      const csv = rowToCsv({
        timestamp: new Date(),
        action: 'test "quoted"',
        userId: null,
        ipAddress: null,
        severity: "info",
        outcome: "success",
        resource: null,
        resourceId: null,
        metadata: null,
      });
      expect(csv).toContain('""quoted""');
    });

    it("neutralizes formula injection (CSV injection / CWE-1236)", () => {
      // Each formula trigger should be prefixed with a single quote to prevent
      // execution when the CSV is opened in Excel/Sheets/LibreOffice.
      const triggers = ["=cmd|'/c calc'!A0", "+1+1", "-1-1", "@SUM(A1)", "\tHIDDEN", "\rHIDDEN"];
      for (const trigger of triggers) {
        const csv = rowToCsv({
          timestamp: new Date("2026-01-01T00:00:00Z"),
          action: "test",
          userId: null,
          ipAddress: null,
          severity: "info",
          outcome: "success",
          resource: null,
          resourceId: trigger,
          metadata: null,
        });
        // The escaped value should start with a single quote
        expect(csv).toContain(`"'${trigger.replace(/"/g, '""')}"`);
      }
    });

    it("does not prefix safe values", () => {
      const csv = rowToCsv({
        timestamp: new Date("2026-01-01T00:00:00Z"),
        action: "auth.login",
        userId: "user-123",
        ipAddress: "1.2.3.4",
        severity: "info",
        outcome: "success",
        resource: "User",
        resourceId: "normal-id",
        metadata: null,
      });
      // No leading quote should appear before normal values
      expect(csv).toContain('"normal-id"');
      expect(csv).not.toContain('"\'normal-id"');
    });
  });

  describe("CSV_HEADER", () => {
    it("contains expected columns", () => {
      expect(CSV_HEADER).toContain("timestamp");
      expect(CSV_HEADER).toContain("action");
      expect(CSV_HEADER).toContain("severity");
    });
  });
});
