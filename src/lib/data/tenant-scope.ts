/**
 * Row-Level Security helper for Prisma.
 * Sets the PostgreSQL session variable before executing queries.
 *
 * Usage:
 *   const users = await withTenantScope(accountId, (tx) =>
 *     tx.user.findMany()
 *   );
 *
 * NOTE: RLS policies are defined but only enforced for the `westbridge_app`
 * database role. The default superuser role used by Prisma bypasses RLS.
 * To fully enforce RLS at the database level, switch DATABASE_URL to
 * connect as the `westbridge_app` role.
 * See: prisma/migrations/20260318_add_row_level_security/migration.sql
 */
import { prisma } from "./prisma.js";

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function withTenantScope<T>(accountId: string, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`;
    return fn(tx);
  });
}
