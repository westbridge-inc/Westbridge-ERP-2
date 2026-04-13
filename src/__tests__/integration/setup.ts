/**
 * Integration test setup — provides Prisma client connected to a real test database.
 *
 * Tests in this directory are SKIPPED unless the TEST_DATABASE_URL environment
 * variable is set. This keeps `npm test` fast for local development while allowing
 * CI to run integration tests with a Postgres service container.
 *
 * Usage:
 *   TEST_DATABASE_URL=postgresql://... npx vitest run src/__tests__/integration/
 *
 * The setup creates a separate Prisma client pointed at the test database,
 * applies migrations, and cleans up data between tests.
 */

import { PrismaClient } from "@prisma/client";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Call at the top of every integration test file:
 *   const shouldSkip = !TEST_DB_URL;
 *   describe.skipIf(shouldSkip)("...",  => { ... });
 */
export function getTestPrisma(): PrismaClient {
  if (!TEST_DB_URL) {
    throw new Error(
      "TEST_DATABASE_URL not set — integration tests require a real Postgres database"
    );
  }
  return new PrismaClient({
    datasources: { db: { url: TEST_DB_URL } },
    log: [], // silent in tests
  });
}

/**
 * Clean all tables in reverse FK order. Faster than dropping/recreating the schema.
 */
export async function cleanDatabase(prisma: PrismaClient): Promise<void> {
  // Delete in correct order to respect foreign key constraints
  await prisma.passwordResetToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.inviteToken.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.user.deleteMany();
  await prisma.account.deleteMany();
}
