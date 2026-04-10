import { describe, it, expect, vi } from 'vitest';
import { validateJournalEntry } from '../journal.validator.js';
import { validateDocumentReferences } from '../document.validator.js';
import { prisma } from "../../../lib/data/prisma.js";

// Mock the DB layer
vi.mock("../../../lib/data/prisma.js", () => ({
  prisma: {
    account: { findMany: vi.fn() },
    document: { findMany: vi.fn() }
  }
}));

describe('Full validation chain', () => {
  const testTenantId = 'integration-tenant';

  it('blocks hallucinated journal entry from reaching database', async () => {
    // Setup Mock: the database knows nothing about these fake entities
    (prisma.account.findMany as any).mockResolvedValue([
      { code: '4000', frozen: false, isGroup: false }
    ]);
    (prisma as any).document.findMany.mockResolvedValue([]);

    // Simulate AI proposing a journal entry with fake account AND fake invoice
    const aiProposal = {
      postingDate: '2026-04-09',
      narration: 'Revenue from INV-2026-9999', // This invoice doesn't exist
      lines: [
        { accountCode: 'HALLUCINATED-001', debit: 5000, credit: 0 },
        { accountCode: '4000', debit: 0, credit: 5000 },
      ],
    };
    
    // Step 1: Run through journal validation chain
    const journalValidation = await validateJournalEntry(aiProposal, testTenantId);
    expect(journalValidation.valid).toBe(false);
    expect(journalValidation.hallucinated).toContain('HALLUCINATED-001');

    // Step 2: Run through document references validation chain
    const docValidation = await validateDocumentReferences(aiProposal.narration, testTenantId);
    expect(docValidation.valid).toBe(false);
    expect(docValidation.hallucinated).toContain('INV-2026-9999');
  });

  it('allows valid journal entry through the full chain', async () => {
    (prisma.account.findMany as any).mockResolvedValue([
      { code: '1000', frozen: false, isGroup: false },
      { code: '4000', frozen: false, isGroup: false }
    ]);
    (prisma as any).document.findMany.mockResolvedValue([
      { docNumber: 'INV-2026-0001' }
    ]);

    const validProposal = {
      postingDate: new Date().toISOString(),
      narration: 'Revenue from INV-2026-0001',
      lines: [
        { accountCode: '1000', debit: 5000, credit: 0 },
        { accountCode: '4000', debit: 0, credit: 5000 },
      ],
    };

    const journalValidation = await validateJournalEntry(validProposal, testTenantId);
    expect(journalValidation.valid).toBe(true);

    const docValidation = await validateDocumentReferences(validProposal.narration, testTenantId);
    expect(docValidation.valid).toBe(true);
  });
});
