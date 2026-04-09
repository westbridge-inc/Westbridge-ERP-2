/**
 * search_contacts — find Customers and Suppliers by name fragment.
 *
 * Phase 7 of the AI-Native ERP overhaul. Pre-binds the doctype set so the
 * agent can find a counterparty by partial name across both Customer and
 * Supplier tables in a single call. Read-only.
 *
 * Used by: finance.payment (verifying a supplier exists before scheduling),
 * finance.reconcile (matching bank descriptions to known counterparties),
 * conversation ("does ABC Trading exist as a customer?").
 */

import { executeTool } from "../../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../../protocol.js";

interface SearchContactsInput {
  query: string;
  type?: "customer" | "supplier" | "both";
  limit?: number;
}

interface ContactRow {
  name: string;
  type: "customer" | "supplier";
  email?: string;
  phone?: string;
  address?: string;
}

async function searchOne(
  ctx: CortexToolContext,
  doctype: "Customer" | "Supplier",
  query: string,
  limit: number,
): Promise<ContactRow[]> {
  const raw = await executeTool(
    "list_records",
    {
      doctype,
      limit,
      filters: { name: ["like", `%${query}%`] },
      fields:
        doctype === "Customer"
          ? ["name", "customer_name", "email_id", "mobile_no"]
          : ["name", "supplier_name", "email_id", "mobile_no"],
    },
    ctx.erpnextSid ?? "",
    ctx.accountId,
    ctx.erpnextCompany,
  );
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
    return rows.map((r: Record<string, unknown>) => ({
      name: String(r.name ?? ""),
      type: doctype.toLowerCase() as "customer" | "supplier",
      email: r.email_id ? String(r.email_id) : undefined,
      phone: r.mobile_no ? String(r.mobile_no) : undefined,
    }));
  } catch {
    return [];
  }
}

export const searchContactsTool: CortexToolDefinition = {
  name: "search_contacts",
  description:
    "Search for customers and/or suppliers by name fragment. Returns matching rows with name, type (customer|supplier), email, and phone.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Substring to search for in customer/supplier names" },
      type: {
        type: "string",
        enum: ["customer", "supplier", "both"],
        default: "both",
      },
      limit: { type: "number", description: "Max results per type (default 25, max 100)" },
    },
    required: ["query"],
  },
  sideEffects: false,
  requiresApproval: false,
  reversible: true,
  maxCallsPerRun: 5,
  handler: async (input: unknown, ctx: CortexToolContext): Promise<string> => {
    const params = (input ?? {}) as SearchContactsInput;
    if (!params.query?.trim()) {
      throw new Error("search_contacts: query is required and must be a non-empty string");
    }
    const type = params.type ?? "both";
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);

    const results: ContactRow[] = [];
    if (type === "customer" || type === "both") {
      results.push(...(await searchOne(ctx, "Customer", params.query, limit)));
    }
    if (type === "supplier" || type === "both") {
      results.push(...(await searchOne(ctx, "Supplier", params.query, limit)));
    }

    return JSON.stringify({ query: params.query, type, count: results.length, results });
  },
};
