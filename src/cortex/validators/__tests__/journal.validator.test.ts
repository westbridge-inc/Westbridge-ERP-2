import { describe, it, expect, vi } from 'vitest';
import { validateJournalEntry } from '../journal.validator.js';
import { prisma } from "../../../lib/data/prisma.js";

// Mock the prisma dependency
vi.mock("../../../lib/data/prisma.js", () => ({
  prisma: {
    account: {
      findMany: vi.fn(),
    },
    contact: {
      findUnique: vi.fn(),
    }
  }
}));

describe('Journal Validator', () => {
  const tenantId = 'test-tenant';

  it('allows valid journal entry', async () => {
    // Mock the DB finding valid active accounts
    (prisma.account.findMany as any).mockResolvedValue([
      { code: '1000', frozen: false, isGroup: false },
      { code: '4000', frozen: false, isGroup: false }
    ]);
    
    const validProposal = {
      postingDate: new Date().toISOString(),
      narration: 'Valid proposal',
      lines: [
        { accountCode: '1000', debit: 500, credit: 0 },
        { accountCode: '4000', debit: 0, credit: 500 }
      ]
    };
    
    const result = await validateJournalEntry(validProposal, tenantId);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects unbalanced entries', async () => {
    (prisma.account.findMany as any).mockResolvedValue([
      { code: '1000', frozen: false, isGroup: false },
      { code: '2000', frozen: false, isGroup: false }
    ]);
    const unbalanced = {
      postingDate: new Date().toISOString(),
      narration: 'Unbalanced',
      lines: [
        { accountCode: '1000', debit: 500, credit: 0 },
        { accountCode: '2000', debit: 0, credit: 499 },
      ]
    };
    const result = await validateJournalEntry(unbalanced, tenantId);
    expect(result.valid).toBe(false);
    expect(result.errors.join('')).toContain('UNBALANCED');
  });

  it('rejects hallucinated account codes', async () => {
    (prisma.account.findMany as any).mockResolvedValue([
      { code: '1000', frozen: false, isGroup: false }
    ]);
    const fake = {
      postingDate: new Date().toISOString(),
      narration: 'Fake account',
      lines: [
        { accountCode: 'FAKE-9999', debit: 100, credit: 0 },
        { accountCode: '1000', debit: 0, credit: 100 },
      ]
    };
    const result = await validateJournalEntry(fake, tenantId);
    expect(result.valid).toBe(false);
    expect(result.errors.join('')).toContain('does not exist');
    expect(result.hallucinated).toContain('FAKE-9999');
  });

  it('rejects posting to frozen accounts', async () => {
    (prisma.account.findMany as any).mockResolvedValue([
      { code: '1000', frozen: false, isGroup: false },
      { code: '5000', frozen: true, isGroup: false } // Frozen!
    ]);
    const frozen = {
      postingDate: new Date().toISOString(),
      narration: 'Frozen account test',
      lines: [
        { accountCode: '1000', debit: 100, credit: 0 },
        { accountCode: '5000', debit: 0, credit: 100 },
      ]
    };
    const result = await validateJournalEntry(frozen, tenantId);
    expect(result.valid).toBe(false);
    expect(result.errors.join('')).toContain('is frozen');
  });

  it('warns on exchange rate above 1000', async () => {
    (prisma.account.findMany as any).mockResolvedValue([
      { code: '1000', frozen: false, isGroup: false },
      { code: '4000', frozen: false, isGroup: false }
    ]);
    const highRate = {
      postingDate: new Date().toISOString(),
      narration: 'High exchange rate',
      exchangeRate: 1500,
      lines: [
        { accountCode: '1000', debit: 50, credit: 0 },
        { accountCode: '4000', debit: 0, credit: 50 },
      ]
    };
    const result = await validateJournalEntry(highRate, tenantId);
    expect(result.valid).toBe(true); // Warnings don't fail validation
    expect(result.warnings.join('')).toContain('unusually high');
  });
});
