/**
 * get_financial_summary — high-level cash position + AR/AP totals for the
 * current tenant.
 *
 * v7.0 of the AI-Native ERP overhaul. Aggregates the totals an agent or
 * a user typically asks for first when checking on a business: cash on
 * hand, total receivables, total payables, net position, and a simple
 * health flag (positive | tight | negative). Built on top of the existing
 * legacy get_summary tool which already handles the aggregation.
 *
 * Used by: finance.payment (cash check before scheduling), conversation
 * ("how are we doing financially?"), the briefing route.
 */

import { executeTool } from "../../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../../protocol.js";

interface FinancialSummaryShape {
  cashOnHand?: number;
  receivables?: number;
  payables?: number;
  netPosition?: number;
  health?: "positive" | "tight" | "negative";
  asOf?: string;
  // The legacy tool may include extra fields — preserve them via index signature.
  [key: string]: unknown;
}

function deriveHealth(net: number): "positive" | "tight" | "negative" {
  if (net <= 0) return "negative";
  if (net < 5_000) return "tight";
  return "positive";
}

export const getFinancialSummaryTool: CortexToolDefinition = {
  name: "get_financial_summary",
  description:
    "High-level financial summary for the current account. Returns cash on hand, total receivables, total payables, net position, and a health indicator. Always call this before proposing payments or making large financial decisions.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  sideEffects: false,
  requiresApproval: false,
  reversible: true,
  maxCallsPerRun: 3,
  handler: async (_input: unknown, ctx: CortexToolContext): Promise<string> => {
    // Delegate to the existing get_summary tool which already does the
    // aggregation. We then enrich the result with a derived health field
    // so the model has a single signal to anchor recommendations against.
    const raw = await executeTool("get_summary", {}, ctx.erpnextSid ?? "", ctx.accountId, ctx.erpnextCompany);

    let parsed: FinancialSummaryShape;
    try {
      parsed = JSON.parse(raw) as FinancialSummaryShape;
    } catch {
      // Legacy returned an error string — pass through unchanged so the
      // model sees the upstream error verbatim.
      return raw;
    }

    const cashOnHand = Number(parsed.cashOnHand ?? 0);
    const receivables = Number(parsed.receivables ?? 0);
    const payables = Number(parsed.payables ?? 0);
    const netPosition = cashOnHand + receivables - payables;

    return JSON.stringify({
      ...parsed,
      cashOnHand,
      receivables,
      payables,
      netPosition,
      health: deriveHealth(netPosition),
      asOf: new Date().toISOString().slice(0, 10),
    });
  },
};
