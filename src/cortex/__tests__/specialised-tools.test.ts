/**
 * v7.0 specialised Cortex tool tests — verifies the tools wire to the
 * legacy executeTool with the right doctype/filter args, validate input,
 * and return the expected shape.
 *
 * The legacy executeTool is mocked end-to-end so the tests run without an
 * ERPNext connection. We assert on the call arguments rather than on the
 * underlying ERPNext response.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const fakeExecuteTool = vi.hoisted(() => vi.fn());

vi.mock("../../lib/ai/tools.js", () => ({
  ERP_TOOLS: [],
  executeTool: fakeExecuteTool,
}));

import {
  getAccountsTool,
  getInvoicesTool,
  getOutstandingTool,
  createJournalEntryTool,
  getBankTransactionsTool,
  getFinancialSummaryTool,
  searchContactsTool,
  getStockLevelsTool,
  analyticsQueryTool,
  JOURNAL_AGENT_TOOLS,
  RECONCILE_AGENT_TOOLS,
  PAYMENT_AGENT_TOOLS,
  EXTRACTION_AGENT_TOOLS,
  ANALYTICS_TOOLS,
} from "../tools/index.js";
import type { CortexToolContext } from "../protocol.js";

const ctx: CortexToolContext = {
  accountId: "acc_1",
  userId: "usr_1",
  agentId: "test",
  traceId: "trace_1",
  autonomyLevel: 3,
  erpnextCompany: "Test Co",
  erpnextSid: "sid_xyz",
  prisma: {} as never,
};

beforeEach(() => {
  fakeExecuteTool.mockReset();
});

// ─── get_accounts ──────────────────────────────────────────────────────────

describe("get_accounts", () => {
  it("delegates to list_records with doctype=Account", async () => {
    fakeExecuteTool.mockResolvedValue("[]");
    await getAccountsTool.handler({}, ctx);

    expect(fakeExecuteTool).toHaveBeenCalledWith(
      "list_records",
      expect.objectContaining({ doctype: "Account", limit: 50 }),
      "sid_xyz",
      "acc_1",
      "Test Co",
    );
  });

  it("clamps limit between 1 and 200", async () => {
    fakeExecuteTool.mockResolvedValue("[]");
    await getAccountsTool.handler({ limit: 999 }, ctx);
    expect(fakeExecuteTool.mock.calls[0][1].limit).toBe(200);

    fakeExecuteTool.mockClear();
    await getAccountsTool.handler({ limit: -5 }, ctx);
    expect(fakeExecuteTool.mock.calls[0][1].limit).toBe(1);
  });

  it("applies a name LIKE filter when search is provided", async () => {
    fakeExecuteTool.mockResolvedValue("[]");
    await getAccountsTool.handler({ search: "bank" }, ctx);
    expect(fakeExecuteTool.mock.calls[0][1].filters.name).toEqual(["like", "%bank%"]);
  });
});

// ─── get_invoices ──────────────────────────────────────────────────────────

describe("get_invoices", () => {
  it("delegates to list_records with doctype=Sales Invoice", async () => {
    fakeExecuteTool.mockResolvedValue("[]");
    await getInvoicesTool.handler({}, ctx);
    expect(fakeExecuteTool.mock.calls[0][1].doctype).toBe("Sales Invoice");
  });

  it("translates filter inputs to ERPNext filter clauses", async () => {
    fakeExecuteTool.mockResolvedValue("[]");
    await getInvoicesTool.handler({ status: "Overdue", customer: "ABC", dateFrom: "2026-01-01", minAmount: 100 }, ctx);
    const args = fakeExecuteTool.mock.calls[0][1];
    expect(args.filters.status).toBe("Overdue");
    expect(args.filters.customer).toEqual(["like", "%ABC%"]);
    expect(args.filters.grand_total).toEqual([">=", 100]);
  });
});

// ─── get_outstanding ───────────────────────────────────────────────────────

describe("get_outstanding", () => {
  it("queries Sales Invoice for receivable ledger", async () => {
    fakeExecuteTool.mockResolvedValue(JSON.stringify([]));
    await getOutstandingTool.handler({ ledger: "receivable" }, ctx);
    expect(fakeExecuteTool.mock.calls[0][1].doctype).toBe("Sales Invoice");
  });

  it("queries Purchase Invoice for payable ledger", async () => {
    fakeExecuteTool.mockResolvedValue(JSON.stringify([]));
    await getOutstandingTool.handler({ ledger: "payable" }, ctx);
    expect(fakeExecuteTool.mock.calls[0][1].doctype).toBe("Purchase Invoice");
  });

  it("rejects unknown ledger values", async () => {
    await expect(getOutstandingTool.handler({ ledger: "loans" }, ctx)).rejects.toThrow(/receivable/);
  });

  it("aggregates rows into aging buckets", async () => {
    const rows = [
      {
        name: "INV-1",
        customer: "A",
        posting_date: "2026-01-01",
        due_date: null,
        grand_total: 100,
        outstanding_amount: 100,
      },
      {
        name: "INV-2",
        customer: "B",
        posting_date: "2026-01-02",
        due_date: "2099-12-31",
        grand_total: 200,
        outstanding_amount: 200,
      },
    ];
    fakeExecuteTool.mockResolvedValue(JSON.stringify(rows));
    const result = JSON.parse((await getOutstandingTool.handler({ ledger: "receivable" }, ctx)) as string);

    expect(result.total).toBe(300);
    expect(result.count).toBe(2);
    // Both invoices land in "current" — null due_date and a far-future date.
    expect(result.byBucket.current).toBe(300);
  });
});

// ─── create_journal_entry ──────────────────────────────────────────────────

describe("create_journal_entry", () => {
  it("rejects unbalanced entries", async () => {
    await expect(
      createJournalEntryTool.handler(
        {
          posting_date: "2026-01-01",
          user_remark: "test",
          accounts: [
            { account: "Cash", debit_in_account_currency: 100 },
            { account: "Revenue", credit_in_account_currency: 90 }, // off by 10
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/balance/);
  });

  it("rejects entries with too few lines", async () => {
    await expect(
      createJournalEntryTool.handler(
        {
          posting_date: "2026-01-01",
          user_remark: "test",
          accounts: [{ account: "Cash", debit_in_account_currency: 100 }],
        },
        ctx,
      ),
    ).rejects.toThrow(/at least 2/);
  });

  it("rejects lines with both debit and credit set", async () => {
    await expect(
      createJournalEntryTool.handler(
        {
          posting_date: "2026-01-01",
          user_remark: "test",
          accounts: [
            { account: "Cash", debit_in_account_currency: 100, credit_in_account_currency: 100 },
            { account: "Revenue", credit_in_account_currency: 100 },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/both/);
  });

  it("delegates to create_record on a balanced entry", async () => {
    fakeExecuteTool.mockResolvedValue('{"name":"JE-001"}');
    await createJournalEntryTool.handler(
      {
        posting_date: "2026-01-01",
        user_remark: "test",
        accounts: [
          { account: "Cash", debit_in_account_currency: 100 },
          { account: "Revenue", credit_in_account_currency: 100 },
        ],
      },
      ctx,
    );
    expect(fakeExecuteTool).toHaveBeenCalledWith(
      "create_record",
      expect.objectContaining({ doctype: "Journal Entry" }),
      "sid_xyz",
      "acc_1",
      "Test Co",
    );
  });
});

// ─── search_contacts ───────────────────────────────────────────────────────

describe("search_contacts", () => {
  it("rejects empty queries", async () => {
    await expect(searchContactsTool.handler({ query: "" }, ctx)).rejects.toThrow();
  });

  it("queries both Customer and Supplier when type=both (default)", async () => {
    fakeExecuteTool.mockResolvedValue(JSON.stringify([]));
    await searchContactsTool.handler({ query: "ABC" }, ctx);
    const doctypes = fakeExecuteTool.mock.calls.map((c) => c[1].doctype);
    expect(doctypes).toContain("Customer");
    expect(doctypes).toContain("Supplier");
  });

  it("queries only Customer when type=customer", async () => {
    fakeExecuteTool.mockResolvedValue(JSON.stringify([]));
    await searchContactsTool.handler({ query: "ABC", type: "customer" }, ctx);
    const doctypes = fakeExecuteTool.mock.calls.map((c) => c[1].doctype);
    expect(doctypes).toEqual(["Customer"]);
  });
});

// ─── analytics_query ───────────────────────────────────────────────────────

describe("analytics_query", () => {
  it("requires a doctype", async () => {
    await expect(analyticsQueryTool.handler({}, ctx)).rejects.toThrow(/doctype/);
  });

  it("clamps the limit at 200", async () => {
    fakeExecuteTool.mockResolvedValue("[]");
    await analyticsQueryTool.handler({ doctype: "Lead", limit: 500 }, ctx);
    expect(fakeExecuteTool.mock.calls[0][1].limit).toBe(200);
  });

  it("delegates to list_records (read-only)", async () => {
    fakeExecuteTool.mockResolvedValue("[]");
    await analyticsQueryTool.handler({ doctype: "Activity Log" }, ctx);
    expect(fakeExecuteTool.mock.calls[0][0]).toBe("list_records");
  });
});

// ─── get_financial_summary ─────────────────────────────────────────────────

describe("get_financial_summary", () => {
  it("delegates to get_summary and enriches with health", async () => {
    fakeExecuteTool.mockResolvedValue(JSON.stringify({ cashOnHand: 10_000, receivables: 5_000, payables: 3_000 }));
    const result = JSON.parse((await getFinancialSummaryTool.handler({}, ctx)) as string);
    expect(result.netPosition).toBe(12_000);
    expect(result.health).toBe("positive");
    expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("flags 'tight' health when net position is small but positive", async () => {
    fakeExecuteTool.mockResolvedValue(JSON.stringify({ cashOnHand: 1_000, receivables: 500, payables: 100 }));
    const result = JSON.parse((await getFinancialSummaryTool.handler({}, ctx)) as string);
    expect(result.health).toBe("tight");
  });

  it("flags 'negative' health when net position is zero or below", async () => {
    fakeExecuteTool.mockResolvedValue(JSON.stringify({ cashOnHand: 100, receivables: 0, payables: 500 }));
    const result = JSON.parse((await getFinancialSummaryTool.handler({}, ctx)) as string);
    expect(result.health).toBe("negative");
  });
});

// ─── Curated bundles ───────────────────────────────────────────────────────

describe("agent tool bundles", () => {
  it("JOURNAL_AGENT_TOOLS includes create_journal_entry", () => {
    expect(JOURNAL_AGENT_TOOLS.map((t) => t.name)).toContain("create_journal_entry");
  });

  it("RECONCILE_AGENT_TOOLS includes get_bank_transactions", () => {
    expect(RECONCILE_AGENT_TOOLS.map((t) => t.name)).toContain("get_bank_transactions");
  });

  it("PAYMENT_AGENT_TOOLS includes get_financial_summary (cash check)", () => {
    expect(PAYMENT_AGENT_TOOLS.map((t) => t.name)).toContain("get_financial_summary");
  });

  it("EXTRACTION_AGENT_TOOLS is read-only — no side-effecting tools", () => {
    for (const tool of EXTRACTION_AGENT_TOOLS) {
      expect(tool.sideEffects).toBe(false);
    }
  });

  it("ANALYTICS_TOOLS includes analytics_query (the escape hatch)", () => {
    expect(ANALYTICS_TOOLS.map((t) => t.name)).toContain("analytics_query");
  });

  it("get_bank_transactions and get_stock_levels are read-only", () => {
    expect(getBankTransactionsTool.sideEffects).toBe(false);
    expect(getStockLevelsTool.sideEffects).toBe(false);
  });
});
