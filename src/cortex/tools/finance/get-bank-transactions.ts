/**
 * get_bank_transactions — list Bank Transaction rows for the current tenant.
 *
 * v7.0 of the AI-Native ERP overhaul. Pre-binds doctype="Bank Transaction"
 * with optional filters by status (Pending|Reconciled|Unreconciled), date,
 * and bank account. Read-only.
 *
 * Used by: finance.reconcile (matching against ledger entries), conversation
 * ("show me yesterday's bank activity").
 */

import { executeTool } from "../../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../../protocol.js";

interface GetBankTransactionsInput {
  status?: "Pending" | "Settled" | "Unreconciled" | "Reconciled" | "Cancelled";
  bankAccount?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export const getBankTransactionsTool: CortexToolDefinition = {
  name: "get_bank_transactions",
  description:
    "List bank transactions for the current account. Filter by status, bank account, and date range. Returns name, date, description, deposit, withdrawal, status, and bank_account.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["Pending", "Settled", "Unreconciled", "Reconciled", "Cancelled"],
      },
      bankAccount: { type: "string" },
      dateFrom: { type: "string", description: "ISO YYYY-MM-DD" },
      dateTo: { type: "string", description: "ISO YYYY-MM-DD" },
      limit: { type: "number", description: "Max results (default 100, max 500)" },
    },
    required: [],
  },
  sideEffects: false,
  requiresApproval: false,
  reversible: true,
  maxCallsPerRun: 6,
  handler: async (input: unknown, ctx: CortexToolContext): Promise<string> => {
    const params = (input ?? {}) as GetBankTransactionsInput;
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);

    const filters: Record<string, unknown> = {};
    if (params.status) filters.status = params.status;
    if (params.bankAccount) filters.bank_account = params.bankAccount;
    if (params.dateFrom && params.dateTo) {
      filters.date = ["between", [params.dateFrom, params.dateTo]];
    } else if (params.dateFrom) {
      filters.date = [">=", params.dateFrom];
    } else if (params.dateTo) {
      filters.date = ["<=", params.dateTo];
    }

    return executeTool(
      "list_records",
      {
        doctype: "Bank Transaction",
        limit,
        filters,
        fields: ["name", "date", "description", "deposit", "withdrawal", "status", "bank_account"],
        order_by: "date desc",
      },
      ctx.erpnextSid ?? "",
      ctx.accountId,
      ctx.erpnextCompany,
    );
  },
};
