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
  "Sales Invoice", "Sales Order", "Purchase Invoice", "Purchase Order",
  "Quotation", "Journal Entry", "Payment Entry", "Stock Entry",
  "Expense Claim", "Leave Application", "Salary Slip", "Employee",
  "Project", "Task", "Timesheet", "Attendance",
]);
