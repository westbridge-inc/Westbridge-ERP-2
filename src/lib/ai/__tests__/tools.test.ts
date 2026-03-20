import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../data/erpnext.client.js", () => ({
  erpList: vi.fn(),
  erpGet: vi.fn(),
  erpCreate: vi.fn(),
}));

vi.mock("../../erp-constants.js", () => ({
  ALLOWED_DOCTYPES_SET: new Set([
    "Sales Invoice",
    "Purchase Invoice",
    "Employee",
    "Stock Ledger Entry",
    "Lead",
    "Payment Entry",
    "Opportunity",
    "Item",
  ]),
}));

import { executeTool, ERP_TOOLS } from "../tools.js";
import { erpList, erpGet, erpCreate } from "../../data/erpnext.client.js";

describe("AI tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ERP_TOOLS has expected tools", () => {
    expect(ERP_TOOLS.length).toBe(12);
    const names = ERP_TOOLS.map((t) => t.name);
    // Generic tools
    expect(names).toContain("list_records");
    expect(names).toContain("get_record");
    expect(names).toContain("create_record");
    expect(names).toContain("get_summary");
    // Domain tools
    expect(names).toContain("get_revenue_summary");
    expect(names).toContain("get_overdue_invoices");
    expect(names).toContain("get_cash_flow");
    expect(names).toContain("get_pipeline_summary");
    expect(names).toContain("get_top_customers");
    expect(names).toContain("get_low_stock_items");
    expect(names).toContain("get_stock_value");
    expect(names).toContain("get_employee_summary");
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

    // ── Domain tool tests ───────────────────────────────────────────────

    describe("get_revenue_summary", () => {
      it("aggregates revenue from sales invoices", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          data: [
            { name: "INV-001", customer_name: "Acme", grand_total: 500, posting_date: "2026-03-01", status: "Paid" },
            { name: "INV-002", customer_name: "Acme", grand_total: 300, posting_date: "2026-03-05", status: "Paid" },
            {
              name: "INV-003",
              customer_name: "Beta Corp",
              grand_total: 200,
              posting_date: "2026-03-10",
              status: "Paid",
            },
          ],
        });
        const result = await executeTool(
          "get_revenue_summary",
          { from_date: "2026-03-01", to_date: "2026-03-19" },
          "sid",
          "acc_1",
          "TestCo",
        );
        const parsed = JSON.parse(result);
        expect(parsed.total_revenue).toBe(1000);
        expect(parsed.invoice_count).toBe(3);
        expect(parsed.average_invoice_value).toBeCloseTo(333.33, 1);
        expect(parsed.top_customers).toHaveLength(2);
        expect(parsed.top_customers[0].name).toBe("Acme");
        expect(parsed.top_customers[0].revenue).toBe(800);
      });

      it("handles error", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "timeout" });
        const result = await executeTool("get_revenue_summary", {}, "sid", "acc_1", null);
        expect(result).toContain("Error fetching revenue");
      });
    });

    describe("get_overdue_invoices", () => {
      it("lists overdue invoices with days overdue", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          data: [
            {
              name: "INV-010",
              customer_name: "Late Co",
              grand_total: 1000,
              outstanding_amount: 800,
              due_date: "2026-02-15",
              posting_date: "2026-01-15",
            },
          ],
        });
        const result = await executeTool("get_overdue_invoices", { limit: 5 }, "sid", "acc_1", null);
        const parsed = JSON.parse(result);
        expect(parsed.overdue_count).toBe(1);
        expect(parsed.total_outstanding).toBe(800);
        expect(parsed.invoices[0].invoice).toBe("INV-010");
        expect(parsed.invoices[0].days_overdue).toBeGreaterThan(0);
      });

      it("handles error", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "fail" });
        const result = await executeTool("get_overdue_invoices", {}, "sid", "acc_1", null);
        expect(result).toContain("Error fetching overdue");
      });
    });

    describe("get_cash_flow", () => {
      it("calculates inflows and outflows", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          data: [
            {
              name: "PE-001",
              payment_type: "Receive",
              paid_amount: 5000,
              posting_date: "2026-03-01",
              party_name: "Client A",
            },
            {
              name: "PE-002",
              payment_type: "Pay",
              paid_amount: 2000,
              posting_date: "2026-03-05",
              party_name: "Vendor B",
            },
            {
              name: "PE-003",
              payment_type: "Receive",
              paid_amount: 3000,
              posting_date: "2026-03-10",
              party_name: "Client C",
            },
          ],
        });
        const result = await executeTool(
          "get_cash_flow",
          { from_date: "2026-03-01", to_date: "2026-03-19" },
          "sid",
          "acc_1",
          null,
        );
        const parsed = JSON.parse(result);
        expect(parsed.inflows).toBe(8000);
        expect(parsed.outflows).toBe(2000);
        expect(parsed.net_cash_flow).toBe(6000);
        expect(parsed.transaction_count).toBe(3);
      });

      it("handles error", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "fail" });
        const result = await executeTool("get_cash_flow", {}, "sid", "acc_1", null);
        expect(result).toContain("Error fetching cash flow");
      });
    });

    describe("get_pipeline_summary", () => {
      it("groups opportunities by stage", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          data: [
            {
              name: "OPP-001",
              sales_stage: "Prospecting",
              opportunity_amount: 10000,
              status: "Open",
              customer_name: "A",
            },
            {
              name: "OPP-002",
              sales_stage: "Prospecting",
              opportunity_amount: 5000,
              status: "Open",
              customer_name: "B",
            },
            {
              name: "OPP-003",
              sales_stage: "Negotiation",
              opportunity_amount: 25000,
              status: "Open",
              customer_name: "C",
            },
          ],
        });
        const result = await executeTool("get_pipeline_summary", {}, "sid", "acc_1", "TestCo");
        const parsed = JSON.parse(result);
        expect(parsed.total_opportunities).toBe(3);
        expect(parsed.total_pipeline_value).toBe(40000);
        expect(parsed.by_stage).toHaveLength(2);
        const prospecting = parsed.by_stage.find((s: { stage: string }) => s.stage === "Prospecting");
        expect(prospecting.count).toBe(2);
        expect(prospecting.total_value).toBe(15000);
      });

      it("handles error", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "fail" });
        const result = await executeTool("get_pipeline_summary", {}, "sid", "acc_1", null);
        expect(result).toContain("Error fetching pipeline");
      });
    });

    describe("get_top_customers", () => {
      it("ranks customers by revenue", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          data: [
            { customer_name: "Big Corp", grand_total: 5000 },
            { customer_name: "Big Corp", grand_total: 3000 },
            { customer_name: "Small LLC", grand_total: 1000 },
          ],
        });
        const result = await executeTool(
          "get_top_customers",
          { from_date: "2026-01-01", to_date: "2026-03-19", limit: 5 },
          "sid",
          "acc_1",
          null,
        );
        const parsed = JSON.parse(result);
        expect(parsed.top_customers).toHaveLength(2);
        expect(parsed.top_customers[0].customer).toBe("Big Corp");
        expect(parsed.top_customers[0].total_revenue).toBe(8000);
        expect(parsed.top_customers[0].invoice_count).toBe(2);
      });

      it("handles error", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "fail" });
        const result = await executeTool("get_top_customers", {}, "sid", "acc_1", null);
        expect(result).toContain("Error fetching customer");
      });
    });

    describe("get_low_stock_items", () => {
      it("returns items with reorder levels", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          data: [
            { name: "ITEM-001", item_name: "Widget A", reorder_level: 10, stock_uom: "Nos" },
            { name: "ITEM-002", item_name: "Widget B", reorder_level: 0, stock_uom: "Nos" },
            { name: "ITEM-003", item_name: "Widget C", reorder_level: 5, stock_uom: "Kg" },
          ],
        });
        const result = await executeTool("get_low_stock_items", { limit: 10 }, "sid", "acc_1", null);
        const parsed = JSON.parse(result);
        // Only items with reorder_level > 0
        expect(parsed.items_with_reorder_levels).toHaveLength(2);
        expect(parsed.items_with_reorder_levels[0].item_code).toBe("ITEM-001");
      });

      it("handles error", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "fail" });
        const result = await executeTool("get_low_stock_items", {}, "sid", "acc_1", null);
        expect(result).toContain("Error fetching item");
      });
    });

    describe("get_stock_value", () => {
      it("calculates total stock value from ledger entries", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          data: [
            { item_code: "ITEM-A", warehouse: "WH-1", stock_value: 5000, qty_after_transaction: 100 },
            { item_code: "ITEM-A", warehouse: "WH-1", stock_value: 4000, qty_after_transaction: 80 }, // older entry, should be skipped
            { item_code: "ITEM-B", warehouse: "WH-1", stock_value: 3000, qty_after_transaction: 50 },
          ],
        });
        const result = await executeTool("get_stock_value", {}, "sid", "acc_1", "TestCo");
        const parsed = JSON.parse(result);
        // ITEM-A:WH-1 first entry (5000) + ITEM-B:WH-1 (3000) = 8000
        expect(parsed.total_stock_value).toBe(8000);
        expect(parsed.unique_item_warehouse_pairs).toBe(2);
      });

      it("handles error", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "fail" });
        const result = await executeTool("get_stock_value", {}, "sid", "acc_1", null);
        expect(result).toContain("Error fetching stock");
      });
    });

    describe("get_employee_summary", () => {
      it("summarizes workforce by department and type", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const recentDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          data: [
            {
              name: "EMP-001",
              employee_name: "Alice",
              department: "Engineering",
              employment_type: "Full-time",
              date_of_joining: recentDate,
              designation: "Dev",
            },
            {
              name: "EMP-002",
              employee_name: "Bob",
              department: "Engineering",
              employment_type: "Full-time",
              date_of_joining: "2025-01-01",
              designation: "Lead",
            },
            {
              name: "EMP-003",
              employee_name: "Carol",
              department: "Sales",
              employment_type: "Part-time",
              date_of_joining: "2024-06-15",
              designation: "Rep",
            },
          ],
        });
        const result = await executeTool("get_employee_summary", {}, "sid", "acc_1", "TestCo");
        const parsed = JSON.parse(result);
        expect(parsed.total_headcount).toBe(3);
        expect(parsed.by_department).toHaveLength(2);
        expect(parsed.by_department[0].department).toBe("Engineering");
        expect(parsed.by_department[0].count).toBe(2);
        expect(parsed.by_employment_type).toHaveLength(2);
        expect(parsed.recent_hires_30d).toHaveLength(1);
        expect(parsed.recent_hires_30d[0].name).toBe("Alice");
      });

      it("handles error", async () => {
        (erpList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: "fail" });
        const result = await executeTool("get_employee_summary", {}, "sid", "acc_1", null);
        expect(result).toContain("Error fetching employee");
      });
    });
  });
});
