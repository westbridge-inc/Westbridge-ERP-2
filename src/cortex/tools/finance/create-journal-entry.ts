/**
 * create_journal_entry — compose and persist a balanced ERPNext Journal
 * Entry document for the current tenant.
 *
 * v7.0 of the AI-Native ERP overhaul. Validates that debits == credits
 * BEFORE calling executeTool, so the engine never asks ERPNext to commit
 * an unbalanced entry. Side-effecting + irreversible — the engine wraps it
 * in the financial-impact gate based on the input total.
 *
 * Used by: finance.journal (the primary author of this tool).
 */

import { executeTool } from "../../../lib/ai/tools.js";
import type { CortexToolContext, CortexToolDefinition } from "../../protocol.js";

interface JournalAccountLine {
  account: string;
  debit_in_account_currency?: number;
  credit_in_account_currency?: number;
  party_type?: "Customer" | "Supplier" | "Employee";
  party?: string;
  reference_type?: "Sales Invoice" | "Purchase Invoice" | "Payment Entry";
  reference_name?: string;
}

interface CreateJournalEntryInput {
  posting_date: string; // YYYY-MM-DD
  user_remark: string;
  accounts: JournalAccountLine[];
  voucher_type?: "Journal Entry" | "Bank Entry" | "Cash Entry" | "Credit Card Entry";
  /** Echoed back into the engine's financial-impact estimator. */
  amount?: number;
}

function sumDebits(lines: JournalAccountLine[]): number {
  return lines.reduce((acc, l) => acc + (Number(l.debit_in_account_currency) || 0), 0);
}
function sumCredits(lines: JournalAccountLine[]): number {
  return lines.reduce((acc, l) => acc + (Number(l.credit_in_account_currency) || 0), 0);
}

export const createJournalEntryTool: CortexToolDefinition = {
  name: "create_journal_entry",
  description:
    "Create a balanced Journal Entry in ERPNext. The accounts array must sum to zero (debits == credits). Returns the created document name on success.",
  inputSchema: {
    type: "object",
    properties: {
      posting_date: { type: "string", description: "ISO YYYY-MM-DD" },
      user_remark: { type: "string", description: "Short human-readable purpose" },
      voucher_type: {
        type: "string",
        enum: ["Journal Entry", "Bank Entry", "Cash Entry", "Credit Card Entry"],
        default: "Journal Entry",
      },
      amount: { type: "number", description: "Top-line amount for financial-impact gating" },
      accounts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            account: { type: "string" },
            debit_in_account_currency: { type: "number" },
            credit_in_account_currency: { type: "number" },
            party_type: { type: "string", enum: ["Customer", "Supplier", "Employee"] },
            party: { type: "string" },
            reference_type: { type: "string", enum: ["Sales Invoice", "Purchase Invoice", "Payment Entry"] },
            reference_name: { type: "string" },
          },
          required: ["account"],
        },
      },
    },
    required: ["posting_date", "user_remark", "accounts"],
  },
  // Side-effecting: writes a new document to ERPNext. The engine will read
  // `amount` from the input and compare it against the agent's
  // maxFinancialImpactUsd ceiling.
  sideEffects: true,
  // Don't require approval inside the tool; the engine's autonomy + financial
  // gate handles that. The journal agent runs at AUTONOMOUS so individual
  // entries below the cap go through; entries above trigger needs_approval.
  requiresApproval: false,
  reversible: false,
  maxCallsPerRun: 5,
  handler: async (input: unknown, ctx: CortexToolContext): Promise<string> => {
    const params = (input ?? {}) as CreateJournalEntryInput;

    // Pre-flight validation. Order matters: per-line checks run BEFORE the
    // sum check so a "both debit + credit set" error fires with a useful
    // message instead of a confusing "doesn't balance" error.
    if (!Array.isArray(params.accounts) || params.accounts.length < 2) {
      throw new Error("create_journal_entry: accounts must be an array of at least 2 lines");
    }

    // 1. Each line must have either debit OR credit non-zero, never both.
    for (const line of params.accounts) {
      const d = Number(line.debit_in_account_currency) || 0;
      const c = Number(line.credit_in_account_currency) || 0;
      if (d > 0 && c > 0) {
        throw new Error(`create_journal_entry: line for "${line.account}" has both debit and credit set`);
      }
      if (d === 0 && c === 0) {
        throw new Error(`create_journal_entry: line for "${line.account}" has neither debit nor credit set`);
      }
    }

    // 2. Sum check — ERPNext will also reject unbalanced entries, but
    //    failing fast here gives the model a clearer error message and saves
    //    a network round-trip. 1-cent rounding tolerance.
    const debits = sumDebits(params.accounts);
    const credits = sumCredits(params.accounts);
    if (Math.abs(debits - credits) > 0.01) {
      throw new Error(
        `create_journal_entry: debits (${debits.toFixed(2)}) do not balance credits (${credits.toFixed(2)})`,
      );
    }

    return executeTool(
      "create_record",
      {
        doctype: "Journal Entry",
        data: {
          posting_date: params.posting_date,
          user_remark: params.user_remark,
          voucher_type: params.voucher_type ?? "Journal Entry",
          accounts: params.accounts,
        },
      },
      ctx.erpnextSid ?? "",
      ctx.accountId,
      ctx.erpnextCompany,
    );
  },
};
