/**
 * Westbridge ERP — pricing, plans, module bundles, and usage limits.
 *
 * Pricing model:
 *   - Flat monthly fee per plan (unlimited-user pricing)
 *   - Hard limits on modules, users, storage, ERP records, and AI
 *   - Automatic overage billing past the plan limits
 *   - AI is a first-class metered feature on every plan
 */

// ─── Plan IDs ─────────────────────────────────────────────────────────────────

export type PlanId = "starter" | "business" | "enterprise";

// ─── Usage Limits ─────────────────────────────────────────────────────────────

export interface PlanLimits {
  users: number; // max active users; -1 = unlimited
  storageGB: number; // GB included; -1 = unlimited
  erpRecordsPerMonth: number; // creates + updates across all doctypes; -1 = unlimited
  apiCallsPerMonth: number; // calls to /api/erp/*; -1 = unlimited
  aiQueriesPerMonth: number; // AI chat + insight requests combined; -1 = unlimited
  aiTokensPerMonth: number; // total AI tokens (input + output); -1 = unlimited
  bundleCount: number; // how many module bundles accessible; -1 = all
}

// ─── Overage Rates ────────────────────────────────────────────────────────────

export interface OverageRates {
  perExtraUser: number; // USD per user per month above limit
  perExtraGB: number; // USD per GB per month above limit
  perExtraErpRecord: number; // USD per record above monthly limit
  perExtraAiQuery: number; // USD per AI query above monthly limit
  perExtra1kApiCalls: number; // USD per 1,000 API calls above limit
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

export interface Plan {
  id: PlanId;
  name: string;
  pricePerMonth: number;
  annualPricePerMonth: number; // 2 months free = ×10/12
  includedBundleIds: string[]; // which module bundles are included
  limits: PlanLimits;
  overageRates: OverageRates;
  features: string[];
  badge?: string;
}

// ─── Module Bundle ────────────────────────────────────────────────────────────

export interface ModuleBundle {
  id: string;
  name: string;
  category: string;
  standalonePrice: number; // price if added outside a plan
  annualStandalonePrice: number;
  moduleIds: string[];
  description: string;
  aiFeatures: string[]; // what AI can do in this bundle
}

// ─── Module ───────────────────────────────────────────────────────────────────

export interface Module {
  id: string;
  name: string;
  category: string;
  bundleId: string;
  erpnextDoctype: string;
  description: string;
}

// ─── Module List ──────────────────────────────────────────────────────────────

const MODULE_LIST: Module[] = [
  // FINANCE & ACCOUNTING
  {
    id: "general-ledger",
    name: "General Ledger",
    category: "Finance & Accounting",
    bundleId: "finance",
    erpnextDoctype: "GL Entry",
    description: "Chart of accounts, journal entries, trial balance.",
  },
  {
    id: "accounts-payable",
    name: "Accounts Payable",
    category: "Finance & Accounting",
    bundleId: "finance",
    erpnextDoctype: "Purchase Invoice",
    description: "Vendor bills and payment tracking.",
  },
  {
    id: "accounts-receivable",
    name: "Accounts Receivable",
    category: "Finance & Accounting",
    bundleId: "finance",
    erpnextDoctype: "Sales Invoice",
    description: "Customer invoices and collections.",
  },
  {
    id: "fixed-assets",
    name: "Fixed Assets",
    category: "Finance & Accounting",
    bundleId: "finance",
    erpnextDoctype: "Asset",
    description: "Asset register and depreciation schedules.",
  },
  {
    id: "bank-reconciliation",
    name: "Bank Reconciliation",
    category: "Finance & Accounting",
    bundleId: "finance",
    erpnextDoctype: "Bank Reconciliation",
    description: "Match bank statements to ledger entries.",
  },
  {
    id: "budgeting-forecasting",
    name: "Budgeting & Forecasting",
    category: "Finance & Accounting",
    bundleId: "finance",
    erpnextDoctype: "Budget",
    description: "Budgets, variance analysis, and financial planning.",
  },
  {
    id: "multi-currency",
    name: "Multi-Currency",
    category: "Finance & Accounting",
    bundleId: "finance",
    erpnextDoctype: "Currency Exchange",
    description: "Multi-currency with live exchange rates.",
  },
  {
    id: "tax-management",
    name: "Tax Management",
    category: "Finance & Accounting",
    bundleId: "finance",
    erpnextDoctype: "Sales Taxes and Charges Template",
    description: "VAT, sales tax, withholding, configurable rules.",
  },
  {
    id: "financial-reporting",
    name: "Financial Reporting",
    category: "Finance & Accounting",
    bundleId: "finance",
    erpnextDoctype: "Report",
    description: "P&L, balance sheet, cash flow, custom reports.",
  },
  // SALES & CRM
  {
    id: "lead-management",
    name: "Lead Management",
    category: "Sales & CRM",
    bundleId: "crm",
    erpnextDoctype: "Lead",
    description: "Capture, qualify, and track inbound leads.",
  },
  {
    id: "opportunity-tracking",
    name: "Opportunity Tracking",
    category: "Sales & CRM",
    bundleId: "crm",
    erpnextDoctype: "Opportunity",
    description: "Deal pipeline, stages, and win/loss analysis.",
  },
  {
    id: "quotation-builder",
    name: "Quotation Builder",
    category: "Sales & CRM",
    bundleId: "crm",
    erpnextDoctype: "Quotation",
    description: "Create, send, and track professional quotes.",
  },
  {
    id: "sales-orders",
    name: "Sales Orders",
    category: "Sales & CRM",
    bundleId: "crm",
    erpnextDoctype: "Sales Order",
    description: "Sales orders, fulfillment, and delivery tracking.",
  },
  {
    id: "customer-portal",
    name: "Customer Portal",
    category: "Sales & CRM",
    bundleId: "crm",
    erpnextDoctype: "Portal Settings",
    description: "Self-service portal for customers.",
  },
  {
    id: "territory-management",
    name: "Territory Management",
    category: "Sales & CRM",
    bundleId: "crm",
    erpnextDoctype: "Territory",
    description: "Sales territories, hierarchy, and rep assignment.",
  },
  // INVENTORY & SUPPLY CHAIN
  {
    id: "stock-management",
    name: "Stock Management",
    category: "Inventory & Supply Chain",
    bundleId: "inventory",
    erpnextDoctype: "Stock Entry",
    description: "Real-time stock levels, movements, and valuation.",
  },
  {
    id: "warehouse-management",
    name: "Warehouse Management",
    category: "Inventory & Supply Chain",
    bundleId: "inventory",
    erpnextDoctype: "Warehouse",
    description: "Multi-warehouse, bins, and location management.",
  },
  {
    id: "purchase-orders",
    name: "Purchase Orders",
    category: "Inventory & Supply Chain",
    bundleId: "inventory",
    erpnextDoctype: "Purchase Order",
    description: "POs, supplier orders, and goods receipts.",
  },
  {
    id: "supplier-management",
    name: "Supplier Management",
    category: "Inventory & Supply Chain",
    bundleId: "inventory",
    erpnextDoctype: "Supplier",
    description: "Supplier master data and performance tracking.",
  },
  {
    id: "bill-of-materials",
    name: "Bill of Materials",
    category: "Inventory & Supply Chain",
    bundleId: "inventory",
    erpnextDoctype: "BOM",
    description: "BOMs, product structures, and component costing.",
  },
  {
    id: "quality-inspection",
    name: "Quality Inspection",
    category: "Inventory & Supply Chain",
    bundleId: "inventory",
    erpnextDoctype: "Quality Inspection",
    description: "Incoming and in-process quality inspections.",
  },
  {
    id: "batch-serial-tracking",
    name: "Batch & Serial Tracking",
    category: "Inventory & Supply Chain",
    bundleId: "inventory",
    erpnextDoctype: "Batch",
    description: "Full batch and serial number traceability.",
  },
  // HR & PAYROLL
  {
    id: "employee-management",
    name: "Employee Management",
    category: "HR & Payroll",
    bundleId: "hr",
    erpnextDoctype: "Employee",
    description: "Employee records, org chart, and documents.",
  },
  {
    id: "attendance-leave",
    name: "Attendance & Leave",
    category: "HR & Payroll",
    bundleId: "hr",
    erpnextDoctype: "Leave Application",
    description: "Leave requests, attendance, and timesheets.",
  },
  {
    id: "payroll-processing",
    name: "Payroll Processing",
    category: "HR & Payroll",
    bundleId: "hr",
    erpnextDoctype: "Salary Slip",
    description: "Payroll runs, tax deductions, and salary slips.",
  },
  {
    id: "expense-claims",
    name: "Expense Claims",
    category: "HR & Payroll",
    bundleId: "hr",
    erpnextDoctype: "Expense Claim",
    description: "Employee expense claims and reimbursements.",
  },
  {
    id: "recruitment",
    name: "Recruitment",
    category: "HR & Payroll",
    bundleId: "hr",
    erpnextDoctype: "Job Applicant",
    description: "Applicant tracking and hiring pipeline.",
  },
  {
    id: "training-development",
    name: "Training & Development",
    category: "HR & Payroll",
    bundleId: "hr",
    erpnextDoctype: "Training Event",
    description: "Training events, certifications, and skill tracking.",
  },
  {
    id: "performance-reviews",
    name: "Performance Reviews",
    category: "HR & Payroll",
    bundleId: "hr",
    erpnextDoctype: "Appraisal",
    description: "Goal setting, KPIs, and performance appraisals.",
  },
  // MANUFACTURING
  {
    id: "production-planning",
    name: "Production Planning",
    category: "Manufacturing",
    bundleId: "manufacturing",
    erpnextDoctype: "Work Order",
    description: "Production plans, MRP, and scheduling.",
  },
  {
    id: "work-orders",
    name: "Work Orders",
    category: "Manufacturing",
    bundleId: "manufacturing",
    erpnextDoctype: "Work Order",
    description: "Work order creation, execution, and tracking.",
  },
  {
    id: "routing-operations",
    name: "Routing & Operations",
    category: "Manufacturing",
    bundleId: "manufacturing",
    erpnextDoctype: "BOM",
    description: "Routings, operations, and workstation management.",
  },
  {
    id: "subcontracting",
    name: "Subcontracting",
    category: "Manufacturing",
    bundleId: "manufacturing",
    erpnextDoctype: "Subcontracting Order",
    description: "Outsourced manufacturing and subcontractor orders.",
  },
  {
    id: "capacity-planning",
    name: "Capacity Planning",
    category: "Manufacturing",
    bundleId: "manufacturing",
    erpnextDoctype: "Workstation",
    description: "Machine capacity, load balancing, bottleneck analysis.",
  },
  // PROJECT MANAGEMENT
  {
    id: "project-tracking",
    name: "Project Tracking",
    category: "Project Management",
    bundleId: "projects",
    erpnextDoctype: "Project",
    description: "Projects, milestones, budgets, and progress.",
  },
  {
    id: "task-management",
    name: "Task Management",
    category: "Project Management",
    bundleId: "projects",
    erpnextDoctype: "Task",
    description: "Tasks, dependencies, assignments, and deadlines.",
  },
  {
    id: "timesheets",
    name: "Timesheets",
    category: "Project Management",
    bundleId: "projects",
    erpnextDoctype: "Timesheet",
    description: "Time logging, billable hours, and project costing.",
  },
  {
    id: "gantt-charts",
    name: "Gantt Charts",
    category: "Project Management",
    bundleId: "projects",
    erpnextDoctype: "Project",
    description: "Visual timelines, Gantt views, and critical path.",
  },
  // BUSINESS TOOLS
  {
    id: "website-builder",
    name: "Website Builder",
    category: "Business Tools",
    bundleId: "biztools",
    erpnextDoctype: "Web Page",
    description: "Build and host your business website.",
  },
  {
    id: "e-commerce",
    name: "E-Commerce",
    category: "Business Tools",
    bundleId: "biztools",
    erpnextDoctype: "Website Item",
    description: "Full online storefront, catalog, and order management.",
  },
  {
    id: "point-of-sale",
    name: "Point of Sale",
    category: "Business Tools",
    bundleId: "biztools",
    erpnextDoctype: "POS Invoice",
    description: "POS terminals for retail, F&B, and counters.",
  },
  {
    id: "custom-reports",
    name: "Custom Reports",
    category: "Business Tools",
    bundleId: "biztools",
    erpnextDoctype: "Report",
    description: "Custom query builder, dashboards, and data exports.",
  },
];

// ─── Module Bundles ───────────────────────────────────────────────────────────

export const MODULE_BUNDLES: ModuleBundle[] = [
  {
    id: "finance",
    name: "Finance & Accounting",
    category: "Finance & Accounting",
    standalonePrice: 399,
    annualStandalonePrice: 332,
    moduleIds: [
      "general-ledger",
      "accounts-payable",
      "accounts-receivable",
      "fixed-assets",
      "bank-reconciliation",
      "budgeting-forecasting",
      "multi-currency",
      "tax-management",
      "financial-reporting",
    ],
    description:
      "Complete double-entry accounting: GL, AP, AR, assets, reconciliation, multi-currency, tax, and financial reporting.",
    aiFeatures: [
      "AI financial summary — CFO-style 30-day report on demand",
      "Cash flow forecast — predicts next 90 days based on your data",
      "Anomaly detection — flags duplicate invoices and unusual transactions",
      "Natural language reports — ask 'top 10 customers by revenue this quarter'",
    ],
  },
  {
    id: "crm",
    name: "Sales & CRM",
    category: "Sales & CRM",
    standalonePrice: 299,
    annualStandalonePrice: 249,
    moduleIds: [
      "lead-management",
      "opportunity-tracking",
      "quotation-builder",
      "sales-orders",
      "customer-portal",
      "territory-management",
    ],
    description:
      "Full sales pipeline: lead capture, opportunity tracking, quotations, sales orders, and customer portal.",
    aiFeatures: [
      "AI deal scoring — probability of close based on deal history",
      "Quote drafting — describe a deal, AI builds the quotation",
      "Follow-up suggestions — AI recommends next actions per opportunity",
      "Win/loss analysis — AI explains why deals are won or lost",
    ],
  },
  {
    id: "inventory",
    name: "Inventory & Supply Chain",
    category: "Inventory & Supply Chain",
    standalonePrice: 349,
    annualStandalonePrice: 290,
    moduleIds: [
      "stock-management",
      "warehouse-management",
      "purchase-orders",
      "supplier-management",
      "bill-of-materials",
      "quality-inspection",
      "batch-serial-tracking",
    ],
    description:
      "End-to-end inventory: multi-warehouse, POs, BOMs, quality inspection, and full batch/serial traceability.",
    aiFeatures: [
      "Reorder suggestions — AI identifies low-stock items before you run out",
      "Demand forecasting — predicts stock needs based on sales velocity",
      "Supplier performance scoring — AI ranks suppliers by reliability and cost",
      "Inventory anomaly detection — flags shrinkage and unusual movements",
    ],
  },
  {
    id: "hr",
    name: "HR & Payroll",
    category: "HR & Payroll",
    standalonePrice: 349,
    annualStandalonePrice: 290,
    moduleIds: [
      "employee-management",
      "attendance-leave",
      "payroll-processing",
      "expense-claims",
      "recruitment",
      "training-development",
      "performance-reviews",
    ],
    description:
      "Complete HR: employee records, payroll, leave, expense claims, recruitment, training, and performance reviews.",
    aiFeatures: [
      "Payroll anomaly detection — flags unusual salary changes and outliers",
      "Attendance insights — AI spots patterns like chronic lateness",
      "Performance coaching — AI summarizes review trends and recommends actions",
      "Job description drafting — AI writes job postings from a brief",
    ],
  },
  {
    id: "manufacturing",
    name: "Manufacturing",
    category: "Manufacturing",
    standalonePrice: 499,
    annualStandalonePrice: 415,
    moduleIds: ["production-planning", "work-orders", "routing-operations", "subcontracting", "capacity-planning"],
    description:
      "Full manufacturing execution: production planning, MRP, work orders, routings, subcontracting, capacity planning.",
    aiFeatures: [
      "Production schedule optimization — AI suggests ideal work order sequencing",
      "Bottleneck analysis — identifies capacity constraints across workstations",
      "Material shortage alerts — AI forecasts BOM shortfalls before production runs",
      "Subcontractor recommendations — ranks subcontractors by cost and lead time",
    ],
  },
  {
    id: "projects",
    name: "Project Management",
    category: "Project Management",
    standalonePrice: 199,
    annualStandalonePrice: 165,
    moduleIds: ["project-tracking", "task-management", "timesheets", "gantt-charts"],
    description:
      "Project tracking, task management, billable timesheets, and Gantt charts — connected to your financials.",
    aiFeatures: [
      "Timeline risk prediction — AI flags projects at risk of delay",
      "Resource allocation suggestions — optimal team assignment across projects",
      "Budget burn analysis — AI predicts if projects will exceed budget",
      "Meeting notes to tasks — paste notes, AI creates structured task lists",
    ],
  },
  {
    id: "biztools",
    name: "Business Tools",
    category: "Business Tools",
    standalonePrice: 299,
    annualStandalonePrice: 249,
    moduleIds: ["website-builder", "e-commerce", "point-of-sale", "custom-reports"],
    description: "Website builder, e-commerce storefront, POS terminals, and custom report builder.",
    aiFeatures: [
      "Sales trend analysis — AI identifies bestsellers and dead stock",
      "POS insights — AI summarizes daily/weekly sales patterns",
      "Custom report generation — describe what you need, AI builds the query",
      "E-commerce product descriptions — AI writes product copy from specs",
    ],
  },
];

// ─── Plans ────────────────────────────────────────────────────────────────────

export const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    pricePerMonth: 500,
    annualPricePerMonth: 416,
    includedBundleIds: ["finance", "crm"],
    limits: {
      users: 10,
      storageGB: 50,
      erpRecordsPerMonth: 2_000,
      apiCallsPerMonth: 10_000,
      aiQueriesPerMonth: 100,
      aiTokensPerMonth: 500_000,
      bundleCount: 2,
    },
    overageRates: {
      perExtraUser: 35,
      perExtraGB: 1.0,
      perExtraErpRecord: 0.01,
      perExtraAiQuery: 0.25,
      perExtra1kApiCalls: 0.05,
    },
    features: [
      "Up to 10 users",
      "Finance & Accounting (9 modules)",
      "Sales & CRM (6 modules)",
      "50 GB storage",
      "100 AI queries / month",
      "2,000 ERP records / month",
      "Email support (24hr)",
      "API access",
      "Overage billing — scale past limits",
    ],
  },
  {
    id: "business",
    name: "Business",
    pricePerMonth: 1_000,
    annualPricePerMonth: 833,
    includedBundleIds: ["finance", "crm", "inventory", "hr"],
    limits: {
      users: 30,
      storageGB: 250,
      erpRecordsPerMonth: 15_000,
      apiCallsPerMonth: 100_000,
      aiQueriesPerMonth: 500,
      aiTokensPerMonth: 3_000_000,
      bundleCount: 4,
    },
    overageRates: {
      perExtraUser: 28,
      perExtraGB: 0.75,
      perExtraErpRecord: 0.007,
      perExtraAiQuery: 0.15,
      perExtra1kApiCalls: 0.03,
    },
    features: [
      "Up to 30 users",
      "Finance, Sales & CRM, Inventory, HR & Payroll",
      "250 GB storage",
      "500 AI queries / month",
      "15,000 ERP records / month",
      "Priority support (4hr response)",
      "Advanced analytics",
      "Multi-warehouse",
      "Overage billing — scale past limits",
    ],
    badge: "Most Popular",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    pricePerMonth: 5_000,
    annualPricePerMonth: 4_166,
    includedBundleIds: ["finance", "crm", "inventory", "hr", "manufacturing", "projects", "biztools"],
    limits: {
      users: -1,
      storageGB: -1,
      erpRecordsPerMonth: -1,
      apiCallsPerMonth: -1,
      aiQueriesPerMonth: -1,
      aiTokensPerMonth: -1,
      bundleCount: -1,
    },
    overageRates: {
      perExtraUser: 0,
      perExtraGB: 0,
      perExtraErpRecord: 0,
      perExtraAiQuery: 0,
      perExtra1kApiCalls: 0,
    },
    features: [
      "Unlimited users",
      "All 38 modules — every bundle included",
      "Manufacturing & Production planning",
      "Project Management",
      "Business Tools (POS, E-Commerce, Website)",
      "Unlimited storage",
      "Unlimited AI — no query limits",
      "Dedicated account manager",
      "1hr SLA support",
      "Custom integrations",
      "SOC 2 compliance reporting",
      "No overage charges — ever",
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const MODULES: Module[] = MODULE_LIST;
export const MODULE_IDS: string[] = MODULE_LIST.map((m) => m.id);

export const CATEGORIES = [
  "Finance & Accounting",
  "Sales & CRM",
  "Inventory & Supply Chain",
  "HR & Payroll",
  "Manufacturing",
  "Project Management",
  "Business Tools",
] as const;

export function getPlan(id: PlanId): Plan {
  const p = PLANS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown plan: ${id}`);
  return p;
}

export function getModule(id: string): Module | undefined {
  return MODULES.find((m) => m.id === id);
}

export function getBundle(id: string): ModuleBundle | undefined {
  return MODULE_BUNDLES.find((b) => b.id === id);
}

export function isBundleIncludedInPlan(bundleId: string, planId: PlanId): boolean {
  return getPlan(planId).includedBundleIds.includes(bundleId);
}

export function isModuleIncludedInPlan(moduleId: string, planId: PlanId): boolean {
  const mod = getModule(moduleId);
  if (!mod) return false;
  return isBundleIncludedInPlan(mod.bundleId, planId);
}

export function getAddOnPrice(moduleId: string, planId: PlanId): number | null {
  if (isModuleIncludedInPlan(moduleId, planId)) return null;
  const mod = getModule(moduleId);
  if (!mod) return null;
  const bundle = getBundle(mod.bundleId);
  return bundle ? bundle.standalonePrice : null;
}

export function formatLimit(value: number, unit = ""): string {
  if (value === -1) return "Unlimited";
  return `${value.toLocaleString()}${unit ? " " + unit : ""}`;
}

export const MODULE_ROWS = MODULES.map((m) => ({
  category: m.category,
  module: m.name,
  moduleId: m.id,
  bundleId: m.bundleId,
}));
