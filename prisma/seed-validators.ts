import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function seedValidatorTestData(tenantId: string) {
  // Clear existing items for clean run
  await (prisma as any).journalEntry?.deleteMany({ where: { tenantId } }).catch(() => {});
  await (prisma as any).document?.deleteMany({ where: { tenantId } }).catch(() => {});
  await prisma.account.deleteMany({ where: { tenantId } });
  await (prisma as any).contact?.deleteMany({ where: { tenantId } }).catch(() => {});

  // Create chart of accounts
  await prisma.account.createMany({
    data: [
      { tenantId, code: '1000', name: 'Cash', accountType: 'Asset', isActive: true, isGroup: false, frozen: false } as any,
      { tenantId, code: '1100', name: 'Accounts Receivable', accountType: 'Asset', isActive: true, isGroup: false, frozen: false } as any,
      { tenantId, code: '2000', name: 'Accounts Payable', accountType: 'Liability', isActive: true, isGroup: false, frozen: false } as any,
      { tenantId, code: '3000', name: 'Equity', accountType: 'Equity', isActive: true, isGroup: true, frozen: false } as any, // Group account — should reject
      { tenantId, code: '4000', name: 'Revenue', accountType: 'Revenue', isActive: true, isGroup: false, frozen: false } as any,
      { tenantId, code: '5000', name: 'Old Account', accountType: 'Expense', isActive: true, isGroup: false, frozen: true } as any, // Frozen — should reject
    ],
  });

  // Create test documents (so reference validator can find them)
  if ((prisma as any).document) {
    await (prisma as any).document.createMany({
      data: [
        { tenantId, docNumber: 'INV-2026-0001', docType: 'sales_invoice', total: 1500, outstandingAmount: 1500 },
        { tenantId, docNumber: 'INV-2026-0002', docType: 'sales_invoice', total: 3200, outstandingAmount: 0 }, // Already paid
        { tenantId, docNumber: 'PO-2026-0001', docType: 'purchase_order', total: 8500, outstandingAmount: 8500 },
      ],
    });
  }

  // Create test contacts
  if ((prisma as any).contact) {
    await (prisma as any).contact.createMany({
      data: [
        { tenantId, id: 'contact-001', name: 'Test Supplier Ltd' },
        { tenantId, id: 'contact-002', name: 'Test Customer Inc' },
      ],
    });
  }
}

async function main() {
  const testTenantId = "tenant-validator-test";
  try {
    await seedValidatorTestData(testTenantId);
    console.log(`Seeded test data for tenant ${testTenantId}`);
  } catch (error) {
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1] === __filename) {
  main();
}
