import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/prisma.js", () => ({
  prisma: { auditLog: { create: vi.fn() } },
}));
vi.mock("../../redis.js", () => ({
  getRedis: vi.fn(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  })),
}));
vi.mock("../../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { logAudit, safeLogAudit, rowToCsv, CSV_HEADER, auditContext } from "../audit.service.js";
import { prisma } from "../../data/prisma.js";

describe("audit.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("logAudit", () => {
    it("writes audit log to database", async () => {
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
      await logAudit({
        accountId: "acc1",
        userId: "user1",
        action: "test.action",
        severity: "info",
        outcome: "success",
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it("skips DB write for system events (null accountId)", async () => {
      await logAudit({ accountId: null, action: "system.boot" });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("redacts IP last octet", async () => {
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
      await logAudit({
        accountId: "acc1",
        action: "test",
        ipAddress: "192.168.1.100",
      });
      const call = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
      expect(call.data.ipAddress).toBe("192.168.1.0");
    });

    it("hashes user agent", async () => {
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
      await logAudit({
        accountId: "acc1",
        action: "test",
        userAgent: "Mozilla/5.0",
      });
      const call = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
      expect(call.data.userAgent).toHaveLength(16);
      expect(call.data.userAgent).not.toBe("Mozilla/5.0");
    });

    it("includes hash chain in metadata", async () => {
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
      await logAudit({ accountId: "acc1", action: "test" });
      const call = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
      const meta = call.data.metadata as Record<string, unknown>;
      expect(meta._hash).toBeDefined();
      expect(meta._prevHash).toBeDefined();
    });

    it("redacts sensitive metadata keys recursively", async () => {
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
      await logAudit({
        accountId: "acc1",
        action: "test",
        meta: {
          safe: "visible",
          password: "should-be-redacted",
          nested: { secret_key: "also-redacted", visible: "ok" },
        },
      });
      const call = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
      const meta = call.data.metadata as Record<string, unknown>;
      expect(meta.safe).toBe("visible");
      expect(meta.password).toBe("[REDACTED]");
      expect((meta.nested as Record<string, unknown>).secret_key).toBe("[REDACTED]");
      expect((meta.nested as Record<string, unknown>).visible).toBe("ok");
    });

    it("does not throw on DB error", async () => {
      vi.mocked(prisma.auditLog.create).mockRejectedValue(new Error("DB down"));
      await expect(logAudit({ accountId: "acc1", action: "test" })).resolves.toBeUndefined();
    });
  });

  describe("safeLogAudit", () => {
    it("does not throw even on error", () => {
      vi.mocked(prisma.auditLog.create).mockRejectedValue(new Error("fail"));
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
  });

  describe("CSV_HEADER", () => {
    it("contains expected columns", () => {
      expect(CSV_HEADER).toContain("timestamp");
      expect(CSV_HEADER).toContain("action");
      expect(CSV_HEADER).toContain("severity");
    });
  });
});
