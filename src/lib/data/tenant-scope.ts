/**
 * Row-Level Security helper for Prisma.
 * Sets the PostgreSQL session variable before executing queries.
 *
 * Usage:
 *   const users = await withTenantScope(accountId, (tx) =>
 *     tx.user.findMany()
 *   );
 */
import { prisma } from "./prisma.js";

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function withTenantScope<T>(accountId: string, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`;
    return fn(tx);
  });
}
