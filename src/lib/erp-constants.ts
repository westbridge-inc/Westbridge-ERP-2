/**
 * Allowlisted ERPNext document types.
 * Centralised here so erp/list, erp/doc, and workers all share the same list.
 * Add new doctypes here when expanding ERP module support.
 */
export const ALLOWED_DOCTYPES = [
  "Sales Invoice",
  "Sales Order",
  "Purchase Invoice",
  "Purchase Order",
  "Quotation",
  "Customer",
  "Supplier",
  "Item",
  "Employee",
  "Journal Entry",
  "Payment Entry",
  "Stock Entry",
  "Expense Claim",
  "Leave Application",
  "Salary Slip",
  "BOM",
  "Company",
  "Account",
  "Warehouse",
  "Stock Ledger Entry",
  "Opportunity",
  "Project",
  "Task",
  "Timesheet",
  "Attendance",
] as const;

export type AllowedDoctype = (typeof ALLOWED_DOCTYPES)[number];

/** Set form for O(1) lookup — use in route handlers. */
export const ALLOWED_DOCTYPES_SET = new Set<string>(ALLOWED_DOCTYPES);

/** Doctypes that have a `company` field — used for tenant isolation checks. */
export const COMPANY_SCOPED_DOCTYPES = new Set([
  "Sales Invoice",
  "Sales Order",
  "Purchase Invoice",
  "Purchase Order",
  "Quotation",
  "Journal Entry",
  "Payment Entry",
  "Stock Entry",
  "Expense Claim",
  "Leave Application",
  "Salary Slip",
  "Employee",
  "Project",
  "Task",
  "Timesheet",
  "Attendance",
]);

/**
 * Maps each allowed doctype to its module bundle ID.
 * Used for plan-based access control — if a doctype's bundle isn't included
 * in the account's plan, access is denied.
 *
 * Doctypes not in this map (e.g. "Company", "Account") are considered
 * always-accessible infrastructure doctypes.
 */
export const DOCTYPE_TO_BUNDLE: Record<string, string> = {
  // Finance & Accounting
  "Sales Invoice": "finance",
  "Purchase Invoice": "finance",
  "Journal Entry": "finance",
  "Payment Entry": "finance",
  Account: "finance",

  // Sales & CRM
  "Sales Order": "crm",
  Quotation: "crm",
  Customer: "crm",
  Opportunity: "crm",

  // Inventory & Supply Chain
  "Purchase Order": "inventory",
  Item: "inventory",
  "Stock Entry": "inventory",
  Supplier: "inventory",
  Warehouse: "inventory",
  "Stock Ledger Entry": "inventory",
  BOM: "inventory",

  // HR & Payroll
  Employee: "hr",
  Attendance: "hr",
  "Leave Application": "hr",
  "Salary Slip": "hr",
  "Expense Claim": "hr",

  // Manufacturing
  // (Uses "BOM" which is already mapped to inventory above — Work Order is not in ALLOWED_DOCTYPES)

  // Project Management
  Project: "projects",
  Task: "projects",
  Timesheet: "projects",
};

/**
 * Check if a doctype is accessible under a given plan.
 *
 * Plan names stored in the DB (e.g. "Starter", "Business") are normalised
 * to the lowercase plan IDs used in modules.ts. If the doctype has no
 * bundle mapping it is treated as always-accessible.
 */
export function isDoctypeAllowedForPlan(doctype: string, plan: string): boolean {
  const bundleId = DOCTYPE_TO_BUNDLE[doctype];
  // Infrastructure doctypes (Company, etc.) have no bundle — always allowed
  if (!bundleId) return true;

  // Normalise plan name to lowercase ID (DB stores "Starter", modules.ts uses "starter")
  const planId = plan.toLowerCase();

  // Plan-to-bundle mapping (mirrors PLANS in modules.ts)
  const PLAN_BUNDLES: Record<string, string[]> = {
    solo: ["finance"],
    starter: ["finance", "crm"],
    business: ["finance", "crm", "inventory", "hr"],
    enterprise: ["finance", "crm", "inventory", "hr", "manufacturing", "projects", "biztools"],
  };

  const allowedBundles = PLAN_BUNDLES[planId];
  // Unknown plans get no access to bundled doctypes
  if (!allowedBundles) return false;

  return allowedBundles.includes(bundleId);
}
