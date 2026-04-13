/**
 * get_outstanding — total outstanding accounts receivable / accounts payable
 * for the current tenant, optionally bucketed by aging window.
 *
 * v7.0 of the AI-Native ERP overhaul. Aggregates over Sales Invoice +
 * Purchase Invoice rows with `outstanding_amount > 0`. Returns the totals
 * and a per-bucket breakdown the agents can use to make payment scheduling
 * decisions or surface "you have $X overdue" insights.
 *
 * Used by: finance.payment (which invoices to pay this week), finance.reconcile
 * (knowing what's still unpaid), conversation ("how much do customers owe us?").
 */

import { executeTool } from "../../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../../protocol.js";

interface GetOutstandingInput {
  /** Which side of the ledger: receivables (sales invoices) or payables (purchase invoices). */
  ledger: "receivable" | "payable";
}

interface InvoiceRow {
  name: string;
  customer?: string;
  supplier?: string;
  posting_date: string;
  due_date: string | null;
  grand_total: number;
  outstanding_amount: number;
}

/** Compute the aging bucket for a due date relative to today. */
function ageBucket(dueDate: string | null): "current" | "1-30" | "31-60" | "61-90" | "90+" {
  if (!dueDate) return "current";
  const due = new Date(dueDate).getTime();
  const days = Math.floor((Date.now - due) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export const getOutstandingTool: CortexToolDefinition = {
  name: "get_outstanding",
  description:
    "Total outstanding receivables (unpaid sales invoices) or payables (unpaid purchase invoices) bucketed by aging. Returns { total, byBucket: { current, '1-30', '31-60', '61-90', '90+' }, count, oldestDueDate }.",
  inputSchema: {
    type: "object",
    properties: {
      ledger: { type: "string", enum: ["receivable", "payable"] },
    },
    required: ["ledger"],
  },
  sideEffects: false,
  requiresApproval: false,
  reversible: true,
  maxCallsPerRun: 4,
  handler: async (input: unknown, ctx: CortexToolContext): Promise<string> => {
    const params = (input ?? {}) as GetOutstandingInput;
    if (params.ledger !== "receivable" && params.ledger !== "payable") {
      throw new Error("get_outstanding: ledger must be 'receivable' or 'payable'");
    }
    const doctype = params.ledger === "receivable" ? "Sales Invoice" : "Purchase Invoice";
    const partyField = params.ledger === "receivable" ? "customer" : "supplier";

    const raw = await executeTool(
      "list_records",
      {
        doctype,
        limit: 500, // 500 open invoices is a sensible cap; agent can paginate if it needs more.
        filters: { outstanding_amount: [">", 0], status: ["!=", "Cancelled"] },
        fields: ["name", partyField, "posting_date", "due_date", "grand_total", "outstanding_amount"],
        order_by: "due_date asc",
      },
      ctx.erpnextSid ?? "",
      ctx.accountId,
      ctx.erpnextCompany,
    );

    // The legacy executeTool returns a JSON string; parse it back so we can
    // aggregate. If parsing fails (an error message string came back) just
    // pass it through to the model so it sees the upstream error.
    let rows: InvoiceRow[];
    try {
      const parsed = JSON.parse(raw);
      rows = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
    } catch {
      return raw;
    }

    const buckets: Record<string, number> = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    let total = 0;
    let oldestDue: string | null = null;
    for (const row of rows) {
      const amount = Number(row.outstanding_amount) || 0;
      total += amount;
      const bucket = ageBucket(row.due_date);
      buckets[bucket] = (buckets[bucket] ?? 0) + amount;
      if (row.due_date && (!oldestDue || row.due_date < oldestDue)) {
        oldestDue = row.due_date;
      }
    }

    return JSON.stringify({
      ledger: params.ledger,
      total: Math.round(total * 100) / 100,
      count: rows.length,
      byBucket: buckets,
      oldestDueDate: oldestDue,
    });
  },
};
