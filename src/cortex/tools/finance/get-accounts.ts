/**
 * get_accounts — list the chart of accounts for the current tenant.
 *
 * Phase 7 of the AI-Native ERP overhaul. Wraps the legacy `list_records`
 * doctype query with `Account` pre-bound, so the agent does not need to
 * remember the doctype name and cannot accidentally query a different
 * doctype with this tool. Read-only, side-effect free.
 *
 * Used by: finance.journal (account name validation), finance.payment
 * (verifying expense accounts before scheduling).
 */

import { executeTool } from "../../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../../protocol.js";

interface GetAccountsInput {
  /** Optional name fragment to filter the chart by. */
  search?: string;
  /** Maximum number of accounts to return. Defaults to 50. */
  limit?: number;
}

export const getAccountsTool: CortexToolDefinition = {
  name: "get_accounts",
  description:
    "List the chart of accounts for the current account. Use this to validate account names before composing journal entries. Returns name, account_type, and parent_account for each row.",
  inputSchema: {
    type: "object",
    properties: {
      search: { type: "string", description: "Optional substring to filter account names by" },
      limit: { type: "number", description: "Max results (default 50, max 200)" },
    },
    required: [],
  },
  sideEffects: false,
  requiresApproval: false,
  reversible: true,
  maxCallsPerRun: 5,
  handler: async (input: unknown, ctx: CortexToolContext): Promise<string> => {
    const params = (input ?? {}) as GetAccountsInput;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    return executeTool(
      "list_records",
      {
        doctype: "Account",
        limit,
        ...(params.search ? { filters: { name: ["like", `%${params.search}%`] } } : {}),
        fields: ["name", "account_type", "parent_account", "is_group"],
      },
      ctx.erpnextSid ?? "",
      ctx.accountId,
      ctx.erpnextCompany,
    );
  },
};
