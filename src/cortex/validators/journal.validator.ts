import { prisma } from "../../lib/data/prisma.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  hallucinated: string[];
}

export interface JournalProposalLine {
  accountCode: string;
  debit: number;
  credit: number;
}

export interface JournalProposal {
  postingDate: string;
  narration: string;
  exchangeRate?: number;
  contactId?: string;
  lines: JournalProposalLine[];
}

export async function validateJournalEntry(proposal: JournalProposal, tenantId: string): Promise<ValidationResult> {
  const result: ValidationResult = { valid: true, errors: [], warnings: [], hallucinated: [] };

  // CHECK: Empty narration
  if (!proposal.narration || proposal.narration.trim() === "") {
    result.errors.push("Empty narration is not allowed.");
  }

  // CHECK: Exchange rates
  if (proposal.exchangeRate !== undefined) {
    if (proposal.exchangeRate < 0) {
      result.errors.push("Exchange rate cannot be negative.");
    } else if (proposal.exchangeRate > 1000) {
      result.warnings.push("Exchange rate unusually high (> 1000).");
    }
  }

  // CHECK: <= 1 line
  if (!proposal.lines || proposal.lines.length < 2) {
    result.errors.push("Journal entry must have at least two lines.");
  }

  // CHECK: Date Validation
  const now = new Date();
  const postingDate = new Date(proposal.postingDate);
  if (isNaN(postingDate.getTime())) {
    result.errors.push("Invalid posting date.");
  } else {
    if (postingDate > now) {
      result.warnings.push("Posting date is in the future.");
    }
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(now.getFullYear() - 1);
    if (postingDate < oneYearAgo) {
      result.warnings.push("Posting date is more than 1 year old.");
    }
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const accountCodes = proposal.lines?.map(l => l.accountCode) || [];

  // Fetch accounts from DB
  const accounts = await prisma.account.findMany({
    where: { tenantId, code: { in: accountCodes } }
  });

  const accountMap = new Map();
  for (const acc of accounts) {
    accountMap.set(acc.code, acc);
  }

  for (const line of proposal.lines || []) {
    totalDebit += line.debit;
    totalCredit += line.credit;

    // CHECK: Both debit and credit
    if (line.debit > 0 && line.credit > 0) {
      result.errors.push(`Line with account ${line.accountCode} contains BOTH debit and credit.`);
    }

    // CHECK: Account exists & Frozen
    const dbAccount = accountMap.get(line.accountCode);
    if (!dbAccount) {
      result.errors.push(`Account ${line.accountCode} does not exist.`);
      result.hallucinated.push(line.accountCode);
    } else {
      if ((dbAccount as any).frozen) {
        result.errors.push(`Account ${line.accountCode} is frozen.`);
      }
      if ((dbAccount as any).isGroup) {
        result.errors.push(`Cannot post directly to group account ${line.accountCode}.`);
      }
    }
  }

  // CHECK: Balanced
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    result.errors.push(`UNBALANCED: Debits (${totalDebit}) do not equal Credits (${totalCredit}).`);
  }

  // CHECK: Contact IDs
  if (proposal.contactId) {
    const contact = (prisma as any).contact ? await (prisma as any).contact.findUnique({
      where: { id_tenantId: { id: proposal.contactId, tenantId } }
    }) : null;
    if (!contact) {
      result.errors.push(`Contact ${proposal.contactId} does not exist.`);
      result.hallucinated.push(proposal.contactId);
    }
  }

  if (result.errors.length > 0) {
    result.valid = false;
  }

  return result;
}
