/**
 * get_stock_levels — current stock-on-hand for items at one or more
 * warehouses for the current tenant.
 *
 * Phase 7 of the AI-Native ERP overhaul. Pre-binds doctype="Bin" which is
 * ERPNext's per-(item, warehouse) inventory snapshot. Read-only.
 *
 * Used by: conversation ("how much widget X do we have in the main warehouse?"),
 * future supply.reorder agent (deciding what to reorder).
 */

import { executeTool } from "../../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../../protocol.js";

interface GetStockLevelsInput {
  itemCode?: string;
  warehouse?: string;
  /** Only return items whose actual_qty < this. Useful for "what's running low?" */
  lowStockThreshold?: number;
  limit?: number;
}

export const getStockLevelsTool: CortexToolDefinition = {
  name: "get_stock_levels",
  description:
    "Current stock-on-hand by (item, warehouse) for the active account. Filter by item code, warehouse, or low-stock threshold. Returns item_code, warehouse, actual_qty, and projected_qty.",
  inputSchema: {
    type: "object",
    properties: {
      itemCode: { type: "string" },
      warehouse: { type: "string" },
      lowStockThreshold: { type: "number", description: "Only return rows where actual_qty < this" },
      limit: { type: "number", description: "Max results (default 100, max 500)" },
    },
    required: [],
  },
  sideEffects: false,
  requiresApproval: false,
  reversible: true,
  maxCallsPerRun: 5,
  handler: async (input: unknown, ctx: CortexToolContext): Promise<string> => {
    const params = (input ?? {}) as GetStockLevelsInput;
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);

    const filters: Record<string, unknown> = {};
    if (params.itemCode) filters.item_code = params.itemCode;
    if (params.warehouse) filters.warehouse = params.warehouse;
    if (params.lowStockThreshold !== undefined) {
      filters.actual_qty = ["<", params.lowStockThreshold];
    }

    return executeTool(
      "list_records",
      {
        doctype: "Bin",
        limit,
        filters,
        fields: ["item_code", "warehouse", "actual_qty", "projected_qty", "reserved_qty", "ordered_qty"],
        order_by: "actual_qty asc",
      },
      ctx.erpnextSid ?? "",
      ctx.accountId,
      ctx.erpnextCompany,
    );
  },
};
