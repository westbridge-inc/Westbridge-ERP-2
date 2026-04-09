/**
 * analytics_query — generic doctype query escape hatch.
 *
 * Phase 7 of the AI-Native ERP overhaul. The other Phase 7 tools (get-accounts,
 * get-invoices, get-bank-transactions, etc) are pre-bound to specific
 * doctypes. This tool exposes the raw `list_records` interface so the
 * conversation agent can answer ad-hoc questions like "how many leads did
 * we capture last month?" without us having to ship a dedicated tool for
 * every doctype the user might ask about.
 *
 * Read-only — wraps `list_records` only, never `create_record` /
 * `update_record` / `delete_record`. Mutations always go through the
 * specialised create_journal_entry / make_payment / etc tools so the
 * engine can apply the right safety gates.
 */

import { executeTool } from "../../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../../protocol.js";

interface AnalyticsQueryInput {
  doctype: string;
  filters?: Record<string, unknown>;
  fields?: string[];
  limit?: number;
  orderBy?: string;
}

export const analyticsQueryTool: CortexToolDefinition = {
  name: "analytics_query",
  description:
    "Generic read-only query against any allowed ERPNext doctype. Returns up to 200 rows. Use this for ad-hoc analytics questions that the specialised tools don't cover. Mutating operations are NOT supported — use the dedicated create / update tools for those.",
  inputSchema: {
    type: "object",
    properties: {
      doctype: { type: "string", description: "ERPNext doctype name, e.g. 'Lead', 'Activity Log', 'Item'" },
      filters: { type: "object", description: "Filter clauses in ERPNext format" },
      fields: { type: "array", items: { type: "string" }, description: "Columns to return" },
      limit: { type: "number", description: "Max rows (default 100, max 200)" },
      orderBy: { type: "string", description: "Sort clause, e.g. 'creation desc'" },
    },
    required: ["doctype"],
  },
  sideEffects: false,
  requiresApproval: false,
  reversible: true,
  maxCallsPerRun: 6,
  handler: async (input: unknown, ctx: CortexToolContext): Promise<string> => {
    const params = (input ?? {}) as AnalyticsQueryInput;
    if (!params.doctype?.trim()) {
      throw new Error("analytics_query: doctype is required");
    }
    // Cap analytics queries at 200 rows. Above that the agent should
    // either narrow the filters or call a specialised aggregation tool.
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);

    return executeTool(
      "list_records",
      {
        doctype: params.doctype,
        limit,
        ...(params.filters ? { filters: params.filters } : {}),
        ...(params.fields ? { fields: params.fields } : {}),
        ...(params.orderBy ? { order_by: params.orderBy } : {}),
      },
      ctx.erpnextSid ?? "",
      ctx.accountId,
      ctx.erpnextCompany,
    );
  },
};
