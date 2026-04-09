/**
 * Journal Entry agent — turns structured business events (an extracted
 * invoice, a matched bank transaction, a payroll run) into ERPNext Journal
 * Entry documents with the right debit / credit splits.
 *
 * Phase 6 of the AI-Native ERP overhaul. The agent NEVER creates an entry
 * with unbalanced debits and credits — the prompt enforces the rule and the
 * Phase 7 create_journal_entry tool re-validates server-side as belt + braces.
 */

import { AUTONOMY, type CortexAgentDefinition } from "../../protocol.js";
import { registerAgent } from "../../registry.js";
import { registerEventHandler } from "../../../events/processor.js";
import { JOURNAL_AGENT_TOOLS } from "../../tools/index.js";

export const JOURNAL_SYSTEM_PROMPT = `
You are the Westbridge Journal Entry Agent. Translate structured business events into ERPNext Journal Entry documents.

INPUT: A business event payload — typically the output of extract.invoice or finance.reconcile, or a payroll-run summary, or a manual adjustment request from a user.

OUTPUT FORMAT (JSON only):
{
  "voucher_type": "Journal Entry",
  "posting_date": "YYYY-MM-DD",
  "company": "string — must come from the tool context, never invent",
  "user_remark": "string — short human-readable purpose",
  "accounts": [
    {
      "account": "string — exact account name from the chart of accounts (use the get_accounts tool to verify)",
      "debit_in_account_currency": number,
      "credit_in_account_currency": number,
      "party_type": "Customer|Supplier|Employee|null",
      "party": "string|null",
      "reference_type": "Sales Invoice|Purchase Invoice|Payment Entry|null",
      "reference_name": "string|null"
    }
  ],
  "warnings": ["string"]
}

HARD RULES:
- Sum of all debit_in_account_currency MUST equal sum of all credit_in_account_currency. Refuse to emit an unbalanced entry — return a warning and an empty accounts array instead.
- ALWAYS use the get_accounts tool first to verify the account names exist in this tenant's chart of accounts before composing the entry. NEVER hallucinate account names.
- Each account line must have either debit OR credit non-zero, never both.
- For multi-currency tenants, posting_date determines the FX rate; let ERPNext compute the converted values, do not pre-compute.
- If a required account is missing from the chart of accounts (e.g. no "Bank Charges" account), return a warning explaining what's missing instead of inventing the account.
`.trim();

export const journalAgent: CortexAgentDefinition = {
  id: "finance.journal",
  name: "Journal Entry Agent",
  description: "Composes balanced Journal Entry documents from structured business events.",
  model: "claude-sonnet-4-6",
  systemPrompt: JOURNAL_SYSTEM_PROMPT,
  maxTokens: 4_000,
  adaptiveThinking: true,
  // Phase 7 wires the journal agent's tool bundle: get_accounts (validation),
  // get_outstanding + get_invoices (looking up source documents),
  // create_journal_entry (the only mutating tool — guarded by the engine's
  // financial-impact gate).
  tools: JOURNAL_AGENT_TOOLS,
  autonomyLevel: AUTONOMY.AUTONOMOUS,
  maxFinancialImpactUsd: 50_000, // Above this, human approval required.
  maxIterations: 5,
  timeoutMs: 60_000,
  dailyTokenBudget: 200_000,
};

registerAgent(journalAgent);

// Sales / purchase invoice creation triggers a journal entry (debit AR /
// credit Revenue, etc). The invoice itself is created by the user; the
// agent's job is to make sure the books are kept correctly.
registerEventHandler("sales_invoice.created", journalAgent.id);
registerEventHandler("purchase_invoice.created", journalAgent.id);
