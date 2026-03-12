import type Anthropic from "@anthropic-ai/sdk";
import { erpList, erpGet, erpCreate } from "../data/erpnext.client.js";
import { ALLOWED_DOCTYPES_SET } from "../erp-constants.js";

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const ERP_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_records",
    description: "List ERP records. Use to fetch invoices, expenses, employees, orders, stock entries, leads, opportunities, projects, etc. Always filter by date range or status to limit results.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctype: { type: "string", description: "ERPNext doctype. Examples: 'Sales Invoice', 'Purchase Invoice', 'Stock Entry', 'Employee', 'Lead', 'Opportunity', 'Project', 'Salary Slip'" },
        filters: { type: "array", description: "Filter arrays: [[doctype, field, operator, value]]. Example: [['Sales Invoice', 'status', '=', 'Unpaid']]", items: { type: "array" } },
        fields: { type: "array", description: "Fields to return", items: { type: "string" } },
        limit: { type: "number", description: "Max records (default 20, max 50)" },
        order_by: { type: "string", description: "Sort. Example: 'posting_date desc'" },
      },
      required: ["doctype"],
    },
  },
  {
    name: "get_record",
    description: "Get a single ERP record by name/ID for full details.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctype: { type: "string" },
        name: { type: "string", description: "The document name/ID" },
      },
      required: ["doctype", "name"],
    },
  },
  {
    name: "create_record",
    description: "Create a new ERP document. Only use when the user explicitly asks to create something. Always confirm details first.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctype: { type: "string" },
        data: { type: "object", description: "Document fields as key-value pairs" },
      },
      required: ["doctype", "data"],
    },
  },
  {
    name: "get_summary",
    description: "Get a quick numeric summary: total revenue, total expenses, open invoices count, stock value, employee count etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        metric: { type: "string", description: "What to summarize: 'revenue', 'expenses', 'open_invoices', 'stock_value', 'employee_count', 'overdue_invoices'" },
        from_date: { type: "string", description: "Start date YYYY-MM-DD" },
        to_date: { type: "string", description: "End date YYYY-MM-DD" },
      },
      required: ["metric"],
    },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  input: unknown,
  sessionId: string,
  accountId: string,
  erpnextCompany: string | null
): Promise<string> {
  try {
    const i = input as Record<string, unknown>;

    // Validate doctype against allowlist before executing any tool that operates on doctypes
    const doctype = i.doctype as string | undefined;
    if (doctype && !ALLOWED_DOCTYPES_SET.has(doctype)) {
      return `Error: doctype "${doctype}" is not allowed. Supported doctypes: ${[...ALLOWED_DOCTYPES_SET].join(", ")}`;
    }

    if (toolName === "list_records") {
      const limit = Math.min((i.limit as number) ?? 20, 50);
      const params: Record<string, string> = {
        limit_page_length: String(limit),
        order_by: (i.order_by as string) ?? "creation desc",
      };
      if (i.fields) params.fields = JSON.stringify(i.fields);

      // Always scope to company (tenant isolation)
      const existingFilters: unknown[][] = i.filters ? (i.filters as unknown[][]) : [];
      const filters = erpnextCompany
        ? [...existingFilters, [i.doctype, "company", "=", erpnextCompany]]
        : existingFilters;
      if (filters.length) params.filters = JSON.stringify(filters);

      const result = await erpList(i.doctype as string, sessionId, params, accountId, erpnextCompany);
      if (!result.ok) return `Error fetching ${i.doctype as string}: ${result.error}`;
      return JSON.stringify(result.data);
    }

    if (toolName === "get_record") {
      const result = await erpGet(i.doctype as string, i.name as string, sessionId, accountId);
      if (!result.ok) return `Error: ${result.error}`;
      return JSON.stringify(result.data);
    }

    if (toolName === "create_record") {
      const data: Record<string, unknown> = { ...(i.data as Record<string, unknown>), docstatus: 0 };
      if (erpnextCompany && !data.company) data.company = erpnextCompany;
      const result = await erpCreate(i.doctype as string, sessionId, data, accountId);
      if (!result.ok) return `Error creating ${i.doctype as string}: ${result.error}`;
      return JSON.stringify({ success: true, data: result.data });
    }

    if (toolName === "get_summary") {
      const metric = i.metric as string;
      const from = (i.from_date as string) ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const to = (i.to_date as string) ?? new Date().toISOString().slice(0, 10);
      const filters: unknown[][] = [];
      if (erpnextCompany) filters.push(["company", "=", erpnextCompany]);

      const summaryMap: Record<string, { doctype: string; field: string }> = {
        revenue:          { doctype: "Sales Invoice",      field: "grand_total" },
        expenses:         { doctype: "Purchase Invoice",   field: "grand_total" },
        open_invoices:    { doctype: "Sales Invoice",      field: "name" },
        overdue_invoices: { doctype: "Sales Invoice",      field: "name" },
        stock_value:      { doctype: "Stock Ledger Entry", field: "stock_value" },
        employee_count:   { doctype: "Employee",           field: "name" },
      };

      const cfg = summaryMap[metric];
      if (!cfg) return `Unknown metric: ${metric}`;

      const dateFilters = cfg.doctype !== "Employee"
        ? [...filters, [cfg.doctype, "posting_date", ">=", from], [cfg.doctype, "posting_date", "<=", to]]
        : [...filters];

      if (metric === "open_invoices") dateFilters.push([cfg.doctype, "status", "in", ["Unpaid", "Overdue"]]);
      if (metric === "overdue_invoices") dateFilters.push([cfg.doctype, "status", "=", "Overdue"]);

      const result = await erpList(cfg.doctype, sessionId, {
        filters: JSON.stringify(dateFilters),
        fields: JSON.stringify([cfg.field]),
        limit_page_length: "500",
      }, accountId, erpnextCompany);

      if (!result.ok) return `Error: ${result.error}`;
      const rows = result.data as Record<string, unknown>[];
      const total = rows.reduce((s, r) => s + (parseFloat(String(r[cfg.field] ?? 0)) || 0), 0);
      return JSON.stringify({ metric, total: Math.round(total * 100) / 100, count: rows.length, period: { from, to } });
    }

    return "Unknown tool";
  } catch (e) {
    return `Tool error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
