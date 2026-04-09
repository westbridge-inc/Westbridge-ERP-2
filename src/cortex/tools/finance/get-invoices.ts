/**
 * get_invoices — list Sales Invoices for the current tenant with optional
 * filters by status, date range, customer, and minimum amount.
 *
 * Phase 7 of the AI-Native ERP overhaul. Pre-binds doctype="Sales Invoice"
 * so agents do not need to remember the doctype string. Read-only.
 *
 * Used by: finance.reconcile (matching bank deposits to invoices),
 * finance.journal (looking up invoices to post), conversation (answering
 * "what invoices are unpaid?" questions).
 */

import { executeTool } from "../../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../../protocol.js";

interface GetInvoicesInput {
  status?: "Draft" | "Submitted" | "Paid" | "Overdue" | "Cancelled" | "Return";
  customer?: string;
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string; // YYYY-MM-DD
  minAmount?: number;
  limit?: number;
}

export const getInvoicesTool: CortexToolDefinition = {
  name: "get_invoices",
  description:
    "List sales invoices for the current account. Filter by status (Draft|Submitted|Paid|Overdue|Cancelled), customer name, posting date range, or minimum grand_total. Returns name, customer, posting_date, due_date, grand_total, status.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["Draft", "Submitted", "Paid", "Overdue", "Cancelled", "Return"],
      },
      customer: { type: "string" },
      dateFrom: { type: "string", description: "ISO YYYY-MM-DD" },
      dateTo: { type: "string", description: "ISO YYYY-MM-DD" },
      minAmount: { type: "number" },
      limit: { type: "number", description: "Max results (default 50, max 500)" },
    },
    required: [],
  },
  sideEffects: false,
  requiresApproval: false,
  reversible: true,
  maxCallsPerRun: 8,
  handler: async (input: unknown, ctx: CortexToolContext): Promise<string> => {
    const params = (input ?? {}) as GetInvoicesInput;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);

    // Build the filters object only with the keys the caller actually
    // supplied so we don't pass undefined to ERPNext.
    const filters: Record<string, unknown> = {};
    if (params.status) filters.status = params.status;
    if (params.customer) filters.customer = ["like", `%${params.customer}%`];
    if (params.dateFrom) filters.posting_date = [">=", params.dateFrom];
    if (params.dateTo) {
      // If both dateFrom and dateTo are set use the "between" operator.
      filters.posting_date = params.dateFrom ? ["between", [params.dateFrom, params.dateTo]] : ["<=", params.dateTo];
    }
    if (params.minAmount !== undefined) filters.grand_total = [">=", params.minAmount];

    return executeTool(
      "list_records",
      {
        doctype: "Sales Invoice",
        limit,
        filters,
        fields: ["name", "customer", "posting_date", "due_date", "grand_total", "status", "outstanding_amount"],
        order_by: "posting_date desc",
      },
      ctx.erpnextSid ?? "",
      ctx.accountId,
      ctx.erpnextCompany,
    );
  },
};
