import type Anthropic from "@anthropic-ai/sdk";
import { erpList, erpGet, erpCreate } from "../data/erpnext.client.js";
import { ALLOWED_DOCTYPES_SET } from "../erp-constants.js";

// ─── Helper: default date range (current month) ─────────────────────────────

function defaultFromDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function defaultToDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Generic Tool Definitions ────────────────────────────────────────────────

const GENERIC_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_records",
    description:
      "List ERP records. Use to fetch invoices, expenses, employees, orders, stock entries, leads, opportunities, projects, etc. Always filter by date range or status to limit results.",
    input_schema: {
      type: "object" as const,
      properties: {
        doctype: {
          type: "string",
          description:
            "Document type. Examples: 'Sales Invoice', 'Purchase Invoice', 'Stock Entry', 'Employee', 'Lead', 'Opportunity', 'Project', 'Salary Slip'",
        },
        filters: {
          type: "array",
          description:
            "Filter arrays: [[doctype, field, operator, value]]. Example: [['Sales Invoice', 'status', '=', 'Unpaid']]",
          items: { type: "array" },
        },
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
    description:
      "Create a new ERP document. Only use when the user explicitly asks to create something. Always confirm details first.",
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
    description:
      "Get a quick numeric summary: total revenue, total expenses, open invoices count, stock value, employee count etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        metric: {
          type: "string",
          description:
            "What to summarize: 'revenue', 'expenses', 'open_invoices', 'stock_value', 'employee_count', 'overdue_invoices'",
        },
        from_date: { type: "string", description: "Start date YYYY-MM-DD" },
        to_date: { type: "string", description: "End date YYYY-MM-DD" },
      },
      required: ["metric"],
    },
  },
];

// ─── Domain-Specific Tool Definitions ────────────────────────────────────────

const DOMAIN_TOOLS: Anthropic.Tool[] = [
  // ── Finance ──
  {
    name: "get_revenue_summary",
    description:
      "Get revenue summary for a period: total revenue, invoice count, average invoice value, and top customers by revenue. Defaults to current month.",
    input_schema: {
      type: "object" as const,
      properties: {
        from_date: { type: "string", description: "Start date YYYY-MM-DD (default: first of current month)" },
        to_date: { type: "string", description: "End date YYYY-MM-DD (default: today)" },
      },
      required: [],
    },
  },
  {
    name: "get_overdue_invoices",
    description:
      "List all sales invoices that are past their due date and still unpaid. Returns customer name, invoice number, amount, due date, and days overdue.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max invoices to return (default 20, max 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_cash_flow",
    description:
      "Calculate cash inflows vs outflows for a period using Payment Entries. Returns total inflows (Receive), outflows (Pay), and net cash flow.",
    input_schema: {
      type: "object" as const,
      properties: {
        from_date: { type: "string", description: "Start date YYYY-MM-DD (default: first of current month)" },
        to_date: { type: "string", description: "End date YYYY-MM-DD (default: today)" },
      },
      required: [],
    },
  },
  // ── CRM ──
  {
    name: "get_pipeline_summary",
    description:
      "Get sales pipeline summary: counts and total value of opportunities grouped by sales stage (e.g. Prospecting, Qualification, Proposal, Negotiation, Closed Won, Closed Lost).",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_top_customers",
    description: "Get top customers ranked by total revenue from paid/submitted Sales Invoices over a period.",
    input_schema: {
      type: "object" as const,
      properties: {
        from_date: { type: "string", description: "Start date YYYY-MM-DD (default: first of current month)" },
        to_date: { type: "string", description: "End date YYYY-MM-DD (default: today)" },
        limit: { type: "number", description: "Number of top customers (default 10, max 25)" },
      },
      required: [],
    },
  },
  // ── Inventory ──
  {
    name: "get_low_stock_items",
    description:
      "List items where current stock quantity is at or below the reorder level. Returns item code, item name, current stock, and reorder level.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max items to return (default 20, max 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_stock_value",
    description:
      "Get total inventory valuation from the latest stock ledger entries. Returns total stock value and item count.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  // ── HR ──
  {
    name: "get_employee_summary",
    description:
      "Get workforce summary: total headcount, breakdown by department, employment type, and recent hires in the last 30 days.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

export const ERP_TOOLS: Anthropic.Tool[] = [...GENERIC_TOOLS, ...DOMAIN_TOOLS];

// ─── Tool Executor ────────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  input: unknown,
  sessionId: string,
  accountId: string,
  erpnextCompany: string | null,
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
        revenue: { doctype: "Sales Invoice", field: "grand_total" },
        expenses: { doctype: "Purchase Invoice", field: "grand_total" },
        open_invoices: { doctype: "Sales Invoice", field: "name" },
        overdue_invoices: { doctype: "Sales Invoice", field: "name" },
        stock_value: { doctype: "Stock Ledger Entry", field: "stock_value" },
        employee_count: { doctype: "Employee", field: "name" },
      };

      const cfg = summaryMap[metric];
      if (!cfg) return `Unknown metric: ${metric}`;

      const dateFilters =
        cfg.doctype !== "Employee"
          ? [...filters, [cfg.doctype, "posting_date", ">=", from], [cfg.doctype, "posting_date", "<=", to]]
          : [...filters];

      if (metric === "open_invoices") dateFilters.push([cfg.doctype, "status", "in", ["Unpaid", "Overdue"]]);
      if (metric === "overdue_invoices") dateFilters.push([cfg.doctype, "status", "=", "Overdue"]);

      const result = await erpList(
        cfg.doctype,
        sessionId,
        {
          filters: JSON.stringify(dateFilters),
          fields: JSON.stringify([cfg.field]),
          limit_page_length: "500",
        },
        accountId,
        erpnextCompany,
      );

      if (!result.ok) return `Error: ${result.error}`;
      const rows = result.data as Record<string, unknown>[];
      const total = rows.reduce((s, r) => s + (parseFloat(String(r[cfg.field] ?? 0)) || 0), 0);
      return JSON.stringify({ metric, total: Math.round(total * 100) / 100, count: rows.length, period: { from, to } });
    }

    // ── Domain-specific tools ───────────────────────────────────────────────

    if (toolName === "get_revenue_summary") {
      const from = (i.from_date as string) ?? defaultFromDate();
      const to = (i.to_date as string) ?? defaultToDate();
      const filters: unknown[][] = [
        ["Sales Invoice", "posting_date", ">=", from],
        ["Sales Invoice", "posting_date", "<=", to],
        ["Sales Invoice", "docstatus", "=", 1],
      ];
      if (erpnextCompany) filters.push(["Sales Invoice", "company", "=", erpnextCompany]);

      const result = await erpList(
        "Sales Invoice",
        sessionId,
        {
          filters: JSON.stringify(filters),
          fields: JSON.stringify(["name", "customer_name", "grand_total", "posting_date", "status"]),
          limit_page_length: "500",
          order_by: "grand_total desc",
        },
        accountId,
        erpnextCompany,
      );

      if (!result.ok) return `Error fetching revenue data: ${result.error}`;
      const rows = result.data as Record<string, unknown>[];
      const totalRevenue = rows.reduce((s, r) => s + (parseFloat(String(r.grand_total ?? 0)) || 0), 0);
      const avgInvoice = rows.length > 0 ? totalRevenue / rows.length : 0;

      // Aggregate top customers
      const custMap = new Map<string, number>();
      for (const r of rows) {
        const cust = String(r.customer_name ?? "Unknown");
        custMap.set(cust, (custMap.get(cust) ?? 0) + (parseFloat(String(r.grand_total ?? 0)) || 0));
      }
      const topCustomers = [...custMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, revenue]) => ({ name, revenue: Math.round(revenue * 100) / 100 }));

      return JSON.stringify({
        period: { from, to },
        total_revenue: Math.round(totalRevenue * 100) / 100,
        invoice_count: rows.length,
        average_invoice_value: Math.round(avgInvoice * 100) / 100,
        top_customers: topCustomers,
      });
    }

    if (toolName === "get_overdue_invoices") {
      const limit = Math.min((i.limit as number) ?? 20, 50);
      const today = defaultToDate();
      const filters: unknown[][] = [
        ["Sales Invoice", "status", "=", "Overdue"],
        ["Sales Invoice", "docstatus", "=", 1],
        ["Sales Invoice", "due_date", "<", today],
      ];
      if (erpnextCompany) filters.push(["Sales Invoice", "company", "=", erpnextCompany]);

      const result = await erpList(
        "Sales Invoice",
        sessionId,
        {
          filters: JSON.stringify(filters),
          fields: JSON.stringify([
            "name",
            "customer_name",
            "grand_total",
            "outstanding_amount",
            "due_date",
            "posting_date",
          ]),
          limit_page_length: String(limit),
          order_by: "due_date asc",
        },
        accountId,
        erpnextCompany,
      );

      if (!result.ok) return `Error fetching overdue invoices: ${result.error}`;
      const rows = result.data as Record<string, unknown>[];
      const todayMs = new Date(today).getTime();
      const invoices = rows.map((r) => {
        const dueMs = new Date(String(r.due_date)).getTime();
        const daysOverdue = Math.max(0, Math.floor((todayMs - dueMs) / 86400000));
        return {
          invoice: r.name,
          customer: r.customer_name,
          total: r.grand_total,
          outstanding: r.outstanding_amount,
          due_date: r.due_date,
          days_overdue: daysOverdue,
        };
      });
      const totalOutstanding = rows.reduce((s, r) => s + (parseFloat(String(r.outstanding_amount ?? 0)) || 0), 0);

      return JSON.stringify({
        overdue_count: invoices.length,
        total_outstanding: Math.round(totalOutstanding * 100) / 100,
        invoices,
      });
    }

    if (toolName === "get_cash_flow") {
      const from = (i.from_date as string) ?? defaultFromDate();
      const to = (i.to_date as string) ?? defaultToDate();
      const filters: unknown[][] = [
        ["Payment Entry", "posting_date", ">=", from],
        ["Payment Entry", "posting_date", "<=", to],
        ["Payment Entry", "docstatus", "=", 1],
      ];
      if (erpnextCompany) filters.push(["Payment Entry", "company", "=", erpnextCompany]);

      const result = await erpList(
        "Payment Entry",
        sessionId,
        {
          filters: JSON.stringify(filters),
          fields: JSON.stringify(["name", "payment_type", "paid_amount", "posting_date", "party_name"]),
          limit_page_length: "500",
          order_by: "posting_date desc",
        },
        accountId,
        erpnextCompany,
      );

      if (!result.ok) return `Error fetching cash flow data: ${result.error}`;
      const rows = result.data as Record<string, unknown>[];
      let inflows = 0;
      let outflows = 0;
      for (const r of rows) {
        const amount = parseFloat(String(r.paid_amount ?? 0)) || 0;
        if (String(r.payment_type) === "Receive") {
          inflows += amount;
        } else if (String(r.payment_type) === "Pay") {
          outflows += amount;
        }
      }

      return JSON.stringify({
        period: { from, to },
        inflows: Math.round(inflows * 100) / 100,
        outflows: Math.round(outflows * 100) / 100,
        net_cash_flow: Math.round((inflows - outflows) * 100) / 100,
        transaction_count: rows.length,
      });
    }

    if (toolName === "get_pipeline_summary") {
      const filters: unknown[][] = [["Opportunity", "status", "!=", ""]];
      if (erpnextCompany) filters.push(["Opportunity", "company", "=", erpnextCompany]);

      const result = await erpList(
        "Opportunity",
        sessionId,
        {
          filters: JSON.stringify(filters),
          fields: JSON.stringify(["name", "sales_stage", "opportunity_amount", "status", "customer_name"]),
          limit_page_length: "500",
          order_by: "creation desc",
        },
        accountId,
        erpnextCompany,
      );

      if (!result.ok) return `Error fetching pipeline data: ${result.error}`;
      const rows = result.data as Record<string, unknown>[];
      const stageMap = new Map<string, { count: number; value: number }>();
      for (const r of rows) {
        const stage = String(r.sales_stage ?? r.status ?? "Unknown");
        const entry = stageMap.get(stage) ?? { count: 0, value: 0 };
        entry.count++;
        entry.value += parseFloat(String(r.opportunity_amount ?? 0)) || 0;
        stageMap.set(stage, entry);
      }
      const stages = [...stageMap.entries()].map(([stage, data]) => ({
        stage,
        count: data.count,
        total_value: Math.round(data.value * 100) / 100,
      }));
      const totalValue = rows.reduce((s, r) => s + (parseFloat(String(r.opportunity_amount ?? 0)) || 0), 0);

      return JSON.stringify({
        total_opportunities: rows.length,
        total_pipeline_value: Math.round(totalValue * 100) / 100,
        by_stage: stages,
      });
    }

    if (toolName === "get_top_customers") {
      const from = (i.from_date as string) ?? defaultFromDate();
      const to = (i.to_date as string) ?? defaultToDate();
      const limit = Math.min((i.limit as number) ?? 10, 25);
      const filters: unknown[][] = [
        ["Sales Invoice", "posting_date", ">=", from],
        ["Sales Invoice", "posting_date", "<=", to],
        ["Sales Invoice", "docstatus", "=", 1],
      ];
      if (erpnextCompany) filters.push(["Sales Invoice", "company", "=", erpnextCompany]);

      const result = await erpList(
        "Sales Invoice",
        sessionId,
        {
          filters: JSON.stringify(filters),
          fields: JSON.stringify(["customer_name", "grand_total"]),
          limit_page_length: "500",
          order_by: "grand_total desc",
        },
        accountId,
        erpnextCompany,
      );

      if (!result.ok) return `Error fetching customer data: ${result.error}`;
      const rows = result.data as Record<string, unknown>[];
      const custMap = new Map<string, { revenue: number; invoice_count: number }>();
      for (const r of rows) {
        const cust = String(r.customer_name ?? "Unknown");
        const entry = custMap.get(cust) ?? { revenue: 0, invoice_count: 0 };
        entry.revenue += parseFloat(String(r.grand_total ?? 0)) || 0;
        entry.invoice_count++;
        custMap.set(cust, entry);
      }
      const customers = [...custMap.entries()]
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, limit)
        .map(([name, data]) => ({
          customer: name,
          total_revenue: Math.round(data.revenue * 100) / 100,
          invoice_count: data.invoice_count,
        }));

      return JSON.stringify({
        period: { from, to },
        top_customers: customers,
      });
    }

    if (toolName === "get_low_stock_items") {
      const limit = Math.min((i.limit as number) ?? 20, 50);

      // Fetch items that have a reorder_level set
      const itemFilters: unknown[][] = [
        ["Item", "is_stock_item", "=", 1],
        ["Item", "disabled", "=", 0],
      ];

      const result = await erpList(
        "Item",
        sessionId,
        {
          filters: JSON.stringify(itemFilters),
          fields: JSON.stringify(["name", "item_name", "stock_uom", "reorder_level"]),
          limit_page_length: String(limit * 2), // fetch extra to filter in-memory
          order_by: "item_name asc",
        },
        accountId,
        erpnextCompany,
      );

      if (!result.ok) return `Error fetching item data: ${result.error}`;
      const items = result.data as Record<string, unknown>[];

      // Return items with reorder_level info; Claude can follow up with list_records on Bin for actual quantities
      const lowStockItems = items
        .filter((item) => {
          const reorderLevel = parseFloat(String(item.reorder_level ?? 0)) || 0;
          return reorderLevel > 0; // only items with reorder levels set
        })
        .slice(0, limit)
        .map((item) => ({
          item_code: item.name,
          item_name: item.item_name,
          reorder_level: parseFloat(String(item.reorder_level ?? 0)) || 0,
          stock_uom: item.stock_uom,
        }));

      return JSON.stringify({
        items_with_reorder_levels: lowStockItems,
        note: "Items shown have reorder levels configured. Use list_records with 'Bin' doctype for actual current stock quantities per warehouse.",
      });
    }

    if (toolName === "get_stock_value") {
      const filters: unknown[][] = [];
      if (erpnextCompany) filters.push(["company", "=", erpnextCompany]);

      // Use Stock Ledger Entry to get latest stock values
      const result = await erpList(
        "Stock Ledger Entry",
        sessionId,
        {
          filters: filters.length > 0 ? JSON.stringify(filters) : undefined,
          fields: JSON.stringify(["item_code", "stock_value", "warehouse", "qty_after_transaction"]),
          limit_page_length: "500",
          order_by: "posting_date desc, posting_time desc",
        },
        accountId,
        erpnextCompany,
      );

      if (!result.ok) return `Error fetching stock data: ${result.error}`;
      const rows = result.data as Record<string, unknown>[];

      // Take latest entry per item+warehouse combination
      const latestMap = new Map<string, Record<string, unknown>>();
      for (const r of rows) {
        const key = `${r.item_code}:${r.warehouse}`;
        if (!latestMap.has(key)) latestMap.set(key, r);
      }

      let totalValue = 0;
      let totalQty = 0;
      for (const r of latestMap.values()) {
        totalValue += parseFloat(String(r.stock_value ?? 0)) || 0;
        totalQty += parseFloat(String(r.qty_after_transaction ?? 0)) || 0;
      }

      return JSON.stringify({
        total_stock_value: Math.round(totalValue * 100) / 100,
        unique_item_warehouse_pairs: latestMap.size,
        total_quantity: Math.round(totalQty * 100) / 100,
      });
    }

    if (toolName === "get_employee_summary") {
      const filters: unknown[][] = [["Employee", "status", "=", "Active"]];
      if (erpnextCompany) filters.push(["Employee", "company", "=", erpnextCompany]);

      const result = await erpList(
        "Employee",
        sessionId,
        {
          filters: JSON.stringify(filters),
          fields: JSON.stringify([
            "name",
            "employee_name",
            "department",
            "employment_type",
            "date_of_joining",
            "designation",
          ]),
          limit_page_length: "500",
          order_by: "date_of_joining desc",
        },
        accountId,
        erpnextCompany,
      );

      if (!result.ok) return `Error fetching employee data: ${result.error}`;
      const rows = result.data as Record<string, unknown>[];

      // Group by department
      const deptMap = new Map<string, number>();
      const typeMap = new Map<string, number>();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const recentHires: { name: string; department: string; joined: string }[] = [];

      for (const r of rows) {
        const dept = String(r.department ?? "Unassigned");
        deptMap.set(dept, (deptMap.get(dept) ?? 0) + 1);
        const empType = String(r.employment_type ?? "Unspecified");
        typeMap.set(empType, (typeMap.get(empType) ?? 0) + 1);
        const joinDate = String(r.date_of_joining ?? "");
        if (joinDate >= thirtyDaysAgo) {
          recentHires.push({
            name: String(r.employee_name ?? r.name),
            department: dept,
            joined: joinDate,
          });
        }
      }

      const byDepartment = [...deptMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([department, count]) => ({ department, count }));
      const byType = [...typeMap.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));

      return JSON.stringify({
        total_headcount: rows.length,
        by_department: byDepartment,
        by_employment_type: byType,
        recent_hires_30d: recentHires,
      });
    }

    return "Unknown tool";
  } catch (e) {
    return `Tool error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
