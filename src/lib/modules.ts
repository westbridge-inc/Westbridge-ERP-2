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

export type PlanId = "solo" | "starter" | "business" | "enterprise";

// ─── Autonomy Levels ──────────────────────────────────────────────────────────
//
// The Cortex AI engine clamps every agent run to the tenant's plan-level
// `maxAutonomyLevel`. Plans never go below L1 (a chatbot-only plan would be
// L0/manual, but we don't sell that). Mirror of the engine's runtime enum
// in src/cortex/protocol.ts; both must stay in sync.
//
//   1 = Assisted        — AI drafts and suggests, human executes everything
//   2 = Supervised      — AI executes routine ops, human reviews after the fact
//   3 = Autonomous      — AI executes, only flags exceptions for human review
//   4 = Self-Optimizing — AI executes AND tunes its own thresholds over time

export type AutonomyLevel = 1 | 2 | 3 | 4;

// ─── Usage Limits ─────────────────────────────────────────────────────────────

export interface PlanLimits {
  users: number; // max active users; -1 = unlimited
  storageGB: number; // GB included; -1 = unlimited
  erpRecordsPerMonth: number; // creates + updates across all doctypes; -1 = unlimited
  apiCallsPerMonth: number; // calls to /api/erp/*; -1 = unlimited
  // AI operations — counts every Cortex agent run, including chat messages,
  // autonomous invoice extraction, bank reconciliation matches, journal entry
  // creation, and any other Anthropic API call from the engine. NOT just chat.
  aiQueriesPerMonth: number; // -1 = unlimited
  aiTokensPerMonth: number; // total AI tokens (input + output); -1 = unlimited
  bundleCount: number; // how many module bundles accessible; -1 = all
}

// ─── Overage Rates ────────────────────────────────────────────────────────────

export interface OverageRates {
  perExtraUser: number; // USD per user per month above limit
  perExtraGB: number; // USD per GB per month above limit
  perExtraErpRecord: number; // USD per record above monthly limit
  perExtraAiQuery: number; // USD per AI operation above monthly limit
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
  /**
   * Hard ceiling on Cortex agent autonomy for tenants on this plan. The
   * engine refuses to run any agent above this level — Solo accounts get
   * supervised execution (human reviews everything), Business+ get
   * self-optimizing autonomous operation. See AutonomyLevel above.
   */
  maxAutonomyLevel: AutonomyLevel;
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
  // HR
  {
    id: "employee-management",
    name: "Employee Management",
    category: "HR",
    bundleId: "hr",
    erpnextDoctype: "Employee",
    description: "Employee records, org chart, and documents.",
  },
  {
    id: "attendance-leave",
    name: "Attendance & Leave",
    category: "HR",
    bundleId: "hr",
    erpnextDoctype: "Leave Application",
    description: "Leave requests, attendance, and timesheets.",
  },
  {
    id: "expense-claims",
    name: "Expense Claims",
    category: "HR",
    bundleId: "hr",
    erpnextDoctype: "Expense Claim",
    description: "Employee expense claims and reimbursements.",
  },
  {
    id: "recruitment",
    name: "Recruitment",
    category: "HR",
    bundleId: "hr",
    erpnextDoctype: "Job Applicant",
    description: "Applicant tracking and hiring pipeline.",
  },
  {
    id: "training-development",
    name: "Training & Development",
    category: "HR",
    bundleId: "hr",
    erpnextDoctype: "Training Event",
    description: "Training events, certifications, and skill tracking.",
  },
  {
    id: "performance-reviews",
    name: "Performance Reviews",
    category: "HR",
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
      "financial-reporting",
    ],
    description:
      "Complete double-entry accounting: GL, AP, AR, assets, reconciliation, multi-currency, and financial reporting.",
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
    name: "HR",
    category: "HR",
    standalonePrice: 349,
    annualStandalonePrice: 290,
    moduleIds: [
      "employee-management",
      "attendance-leave",
      "expense-claims",
      "recruitment",
      "training-development",
      "performance-reviews",
    ],
    description:
      "Complete HR: employee records, leave, expense claims, recruitment, training, and performance reviews.",
    aiFeatures: [
      "Attendance insights — AI spots patterns like chronic lateness",
      "Performance coaching — AI summarizes review trends and recommends actions",
      "Job description drafting — AI writes job postings from a brief",
      "Hiring funnel analysis — AI surfaces drop-off points in your pipeline",
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
    moduleIds: ["website-builder", "custom-reports"],
    description: "Website builder and custom report builder.",
    aiFeatures: [
      "Custom report generation — describe what you need, AI builds the query",
      "Website copy drafting — AI writes page content from a short brief",
      "Trend analysis — AI surfaces patterns in your reporting data",
      "Natural language queries — ask questions, AI builds the report",
    ],
  },
];

// ─── Plans ────────────────────────────────────────────────────────────────────

export const PLANS: Plan[] = [
  {
    id: "solo",
    name: "Solo",
    pricePerMonth: 49.99,
    annualPricePerMonth: 41.66,
    includedBundleIds: ["finance"],
    limits: {
      users: 3,
      storageGB: 10,
      erpRecordsPerMonth: 500,
      apiCallsPerMonth: 5_000,
      // 500 AI ops/mo: enough for ~100 invoices + reconciliation + chat at
      // ~5 ops per invoice flow. The previous 50/mo limit was sized for a
      // chatbot, not an autonomous agent system.
      aiQueriesPerMonth: 500,
      aiTokensPerMonth: 2_000_000,
      bundleCount: 1,
    },
    overageRates: {
      perExtraUser: 15,
      perExtraGB: 1.5,
      perExtraErpRecord: 0.02,
      perExtraAiQuery: 0.08,
      perExtra1kApiCalls: 0.1,
    },
    maxAutonomyLevel: 2,
    features: [
      "Up to 3 users",
      "Finance & Accounting",
      "Invoicing, expenses, journal entries",
      "10 GB storage",
      "500 AI operations / month",
      "AI Assisted — drafts and suggests, you review and approve",
      "Email support",
      "API access",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    pricePerMonth: 199.99,
    annualPricePerMonth: 166.66,
    includedBundleIds: ["finance", "crm"],
    limits: {
      users: 10,
      storageGB: 50,
      erpRecordsPerMonth: 2_000,
      apiCallsPerMonth: 10_000,
      // 2,500 AI ops/mo: room for ~500 invoices + reconciliation + payment
      // scheduling + chat. Starter is the first plan where the AI runs
      // routine operations autonomously rather than requiring approval.
      aiQueriesPerMonth: 2_500,
      aiTokensPerMonth: 10_000_000,
      bundleCount: 2,
    },
    overageRates: {
      perExtraUser: 25,
      perExtraGB: 1.0,
      perExtraErpRecord: 0.01,
      perExtraAiQuery: 0.05,
      perExtra1kApiCalls: 0.05,
    },
    maxAutonomyLevel: 3,
    features: [
      "Up to 10 users",
      "Finance & Accounting",
      "Sales & CRM",
      "50 GB storage",
      "2,500 AI operations / month",
      "AI Autonomous — handles routine operations, escalates exceptions",
      "Priority email support (12hr)",
      "Advanced reporting",
      "Overage billing — scale past limits",
    ],
    badge: "Most Popular",
  },
  {
    id: "business",
    name: "Business",
    pricePerMonth: 999.99,
    annualPricePerMonth: 833.33,
    includedBundleIds: ["finance", "crm", "inventory", "hr"],
    limits: {
      users: 50,
      storageGB: 250,
      erpRecordsPerMonth: 15_000,
      apiCallsPerMonth: 100_000,
      // 15,000 AI ops/mo: covers ~3,000 invoices + full reconciliation +
      // payroll runs + forecasting + chat for a 50-person company.
      // L4 = the AI tunes its own thresholds based on observed accuracy.
      aiQueriesPerMonth: 15_000,
      aiTokensPerMonth: 75_000_000,
      bundleCount: 4,
    },
    overageRates: {
      perExtraUser: 20,
      perExtraGB: 0.75,
      perExtraErpRecord: 0.007,
      perExtraAiQuery: 0.03,
      perExtra1kApiCalls: 0.03,
    },
    maxAutonomyLevel: 4,
    features: [
      "Up to 50 users",
      "Finance, CRM, Inventory, Human Resources",
      "250 GB storage",
      "15,000 AI operations / month",
      "AI Self-Optimizing — operates and continuously improves",
      "Multi-warehouse support",
      "Priority support (4hr response)",
      "Advanced analytics",
      "OIDC single sign-on & TOTP 2FA",
      "Overage billing — scale past limits",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    pricePerMonth: 4_999.99,
    annualPricePerMonth: 4_166.66,
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
    maxAutonomyLevel: 4,
    features: [
      "Unlimited users",
      "All 38 modules included",
      "Manufacturing & production",
      "Project management",
      "Unlimited storage",
      "Unlimited AI operations — no caps",
      "AI Self-Optimizing — operates and continuously improves",
      "Dedicated account manager",
      "Priority email support",
      "Custom integrations",
      "Security audit reports",
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
  "HR",
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
