/**
 * Cortex tools index — central catalog of every Phase 7 specialised tool.
 *
 * Agents import individual tools (or curated bundles) from here so the wire
 * surface stays small and discoverable. The legacy CORTEX_ERP_TOOLS bundle
 * is also re-exported so existing imports keep working.
 */

// Legacy ERP tool bundle (Phase 1) — kept for backwards compatibility with
// the conversation agent and any future agent that needs the full ERPNext
// CRUD surface.
export { CORTEX_ERP_TOOLS } from "./erp.js";

// Phase 7 specialised tools
export { getAccountsTool } from "./finance/get-accounts.js";
export { getInvoicesTool } from "./finance/get-invoices.js";
export { getOutstandingTool } from "./finance/get-outstanding.js";
export { createJournalEntryTool } from "./finance/create-journal-entry.js";
export { getBankTransactionsTool } from "./finance/get-bank-transactions.js";
export { getFinancialSummaryTool } from "./finance/get-financial-summary.js";
export { searchContactsTool } from "./contacts/search.js";
export { getStockLevelsTool } from "./inventory/get-stock-levels.js";
export { analyticsQueryTool } from "./analytics/query.js";

// ── Curated bundles ────────────────────────────────────────────────────────
//
// Each bundle is the typical tool set for one of the Phase 6 specialised
// agents. Agents import the bundle they need rather than picking individual
// tools so the system prompt + tool list stay in sync.

import type { CortexToolDefinition } from "../protocol.js";
import { getAccountsTool } from "./finance/get-accounts.js";
import { getInvoicesTool } from "./finance/get-invoices.js";
import { getOutstandingTool } from "./finance/get-outstanding.js";
import { createJournalEntryTool } from "./finance/create-journal-entry.js";
import { getBankTransactionsTool } from "./finance/get-bank-transactions.js";
import { getFinancialSummaryTool } from "./finance/get-financial-summary.js";
import { searchContactsTool } from "./contacts/search.js";
import { getStockLevelsTool } from "./inventory/get-stock-levels.js";
import { analyticsQueryTool } from "./analytics/query.js";

/** Tools used by the journal entry agent — accounts validation + entry creation. */
export const JOURNAL_AGENT_TOOLS: CortexToolDefinition[] = [
  getAccountsTool,
  getOutstandingTool,
  getInvoicesTool,
  createJournalEntryTool,
];

/** Tools used by the bank reconciliation agent — bank txns + ledger lookup. */
export const RECONCILE_AGENT_TOOLS: CortexToolDefinition[] = [
  getBankTransactionsTool,
  getInvoicesTool,
  getOutstandingTool,
  searchContactsTool,
  getAccountsTool,
];

/** Tools used by the payment scheduling agent — outstanding + cash check. */
export const PAYMENT_AGENT_TOOLS: CortexToolDefinition[] = [
  getOutstandingTool,
  getFinancialSummaryTool,
  searchContactsTool,
  getInvoicesTool,
];

/** Tools used by the invoice extraction agent — read-only access to chart of accounts. */
export const EXTRACTION_AGENT_TOOLS: CortexToolDefinition[] = [getAccountsTool, searchContactsTool];

/** Tools used by the analytics / ad-hoc query side of the conversation agent. */
export const ANALYTICS_TOOLS: CortexToolDefinition[] = [
  analyticsQueryTool,
  getInvoicesTool,
  getOutstandingTool,
  getFinancialSummaryTool,
  getStockLevelsTool,
  getAccountsTool,
  getBankTransactionsTool,
  searchContactsTool,
];
