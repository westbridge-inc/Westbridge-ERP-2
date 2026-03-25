import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/erpnext.client.js", () => ({
  erpList: vi.fn(),
  erpGet: vi.fn(),
  erpCreate: vi.fn(),
  erpUpdate: vi.fn(),
  erpDelete: vi.fn(),
}));

vi.mock("../../erp-constants.js", () => ({
  ALLOWED_DOCTYPES_SET: new Set(["Sales Invoice", "Purchase Invoice", "Employee", "Stock Ledger Entry", "Lead"]),
}));

import { executeTool, ERP_TOOLS } from "../tools.js";
import { erpList, erpGet, erpCreate, erpUpdate, erpDelete } from "../../data/erpnext.client.js";

describe("AI tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ERP_TOOLS has expected tools", () => {
    expect(ERP_TOOLS.length).toBe(6);
    const names = ERP_TOOLS.map((t) => t.name);
    expect(names).toContain("list_records");
    expect(names).toContain("get_record");
    expect(names).toContain("create_record");
    expect(names).toContain("update_record");
    expect(names).toContain("delete_record");
    expect(names).toContain("get_summary");
  });

  describe("executeTool", () => {
    it("rejects disallowed doctypes", async () => {
      const result = await executeTool("list_records", { doctype: "Hacker Table" }, "sid", "acc_1", null);
      expect(result).toContain("not allowed");
    });

    it("handles list_records", async () => {
      (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: [{ name: "INV-001" }],
      });
      const result = await executeTool(
        "list_records",
        { doctype: "Sales Invoice", limit: 10 },
        "sid",
        "acc_1",
        "Test Co",
      );
      expect(JSON.parse(result)).toEqual([{ name: "INV-001" }]);
    });

    it("handles list_records with company filter", async () => {
      (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] });
      await executeTool(
        "list_records",
        { doctype: "Sales Invoice", filters: [["Sales Invoice", "status", "=", "Unpaid"]] },
        "sid",
        "acc_1",
        "MyCompany",
      );
      expect(erpList).toHaveBeenCalled();
    });

    it("handles list_records error", async () => {
      (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "timeout" });
      const result = await executeTool("list_records", { doctype: "Sales Invoice" }, "sid", "acc_1", null);
      expect(result).toContain("Error fetching");
    });

    it("handles get_record", async () => {
      (erpGet as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { name: "INV-001", total: 100 } });
      const result = await executeTool(
        "get_record",
        { doctype: "Sales Invoice", name: "INV-001" },
        "sid",
        "acc_1",
        null,
      );
      expect(JSON.parse(result)).toHaveProperty("name", "INV-001");
    });

    it("handles get_record error", async () => {
      (erpGet as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "not found" });
      const result = await executeTool("get_record", { doctype: "Sales Invoice", name: "X" }, "sid", "acc_1", null);
      expect(result).toContain("Error");
    });

    it("handles create_record", async () => {
      (erpCreate as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { name: "INV-002" } });
      const result = await executeTool(
        "create_record",
        { doctype: "Sales Invoice", data: { customer: "Test" } },
        "sid",
        "acc_1",
        "MyCompany",
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
    });

    it("handles create_record error", async () => {
      (erpCreate as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "validation" });
      const result = await executeTool("create_record", { doctype: "Sales Invoice", data: {} }, "sid", "acc_1", null);
      expect(result).toContain("Error creating");
    });

    it("handles get_summary for revenue", async () => {
      (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: [{ grand_total: 100 }, { grand_total: 200 }],
      });
      const result = await executeTool(
        "get_summary",
        { metric: "revenue", from_date: "2026-01-01", to_date: "2026-03-17" },
        "sid",
        "acc_1",
        null,
      );
      const parsed = JSON.parse(result);
      expect(parsed.metric).toBe("revenue");
      expect(parsed.total).toBe(300);
    });

    it("handles get_summary for employee_count", async () => {
      (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: [{ name: "EMP-001" }, { name: "EMP-002" }],
      });
      const result = await executeTool("get_summary", { metric: "employee_count" }, "sid", "acc_1", "Co");
      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(2);
    });

    it("handles unknown metric", async () => {
      const result = await executeTool("get_summary", { metric: "unknown_metric" }, "sid", "acc_1", null);
      expect(result).toContain("Unknown metric");
    });

    it("handles unknown tool", async () => {
      const result = await executeTool("unknown_tool", {}, "sid", "acc_1", null);
      expect(result).toBe("Unknown tool");
    });

    it("handles thrown exceptions", async () => {
      (erpList as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection timeout"));
      const result = await executeTool("list_records", { doctype: "Sales Invoice" }, "sid", "acc_1", null);
      expect(result).toContain("Tool error");
    });

    it("handles update_record", async () => {
      (erpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        data: { name: "INV-001", status: "Paid" },
      });
      const result = await executeTool(
        "update_record",
        { doctype: "Sales Invoice", name: "INV-001", data: { status: "Paid" } },
        "sid",
        "acc_1",
        "MyCompany",
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(erpUpdate).toHaveBeenCalledWith("Sales Invoice", "INV-001", "sid", { status: "Paid" }, "acc_1");
    });

    it("handles update_record error", async () => {
      (erpUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "not found" });
      const result = await executeTool(
        "update_record",
        { doctype: "Sales Invoice", name: "INV-999", data: { status: "Paid" } },
        "sid",
        "acc_1",
        null,
      );
      expect(result).toContain("Error updating");
    });

    it("rejects update_record with disallowed doctype", async () => {
      const result = await executeTool(
        "update_record",
        { doctype: "Hacker Table", name: "X", data: {} },
        "sid",
        "acc_1",
        null,
      );
      expect(result).toContain("not allowed");
      expect(erpUpdate).not.toHaveBeenCalled();
    });

    it("handles delete_record", async () => {
      (erpDelete as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: {} });
      const result = await executeTool(
        "delete_record",
        { doctype: "Sales Invoice", name: "INV-001" },
        "sid",
        "acc_1",
        null,
      );
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("INV-001");
      expect(erpDelete).toHaveBeenCalledWith("Sales Invoice", "INV-001", "sid", "acc_1");
    });

    it("handles delete_record error", async () => {
      (erpDelete as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "permission denied" });
      const result = await executeTool(
        "delete_record",
        { doctype: "Sales Invoice", name: "INV-001" },
        "sid",
        "acc_1",
        null,
      );
      expect(result).toContain("Error deleting");
    });

    it("rejects delete_record with disallowed doctype", async () => {
      const result = await executeTool("delete_record", { doctype: "Hacker Table", name: "X" }, "sid", "acc_1", null);
      expect(result).toContain("not allowed");
      expect(erpDelete).not.toHaveBeenCalled();
    });
  });
});
