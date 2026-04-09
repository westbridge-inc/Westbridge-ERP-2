/**
 * Row-Level Security helper for Prisma — defence-in-depth tenant isolation.
 *
 * Usage (mandatory in BullMQ workers and any code path that runs OUTSIDE
 * the Express request lifecycle, where the per-request `tenantContext`
 * middleware does not run):
 *
 *   const log = await withTenantScope(accountId, async (tx) =>
 *     tx.cortexExecutionLog.findMany({ where: { agentId } }),
 *   );
 *
 * Why a transaction is required: PostgreSQL's `set_config(name, value, true)`
 * with `is_local=true` only persists for the current TRANSACTION. Each
 * Prisma operation outside an explicit `$transaction` runs in its own
 * implicit transaction and may be assigned a different connection from
 * the pool, so the setting must be made INSIDE the same transaction as
 * the queries it scopes — otherwise the next query sees an unset variable
 * and (when running as the `westbridge_app` role) RLS policies default-
 * deny every row.
 *
 * After the Phase 3 role switch, runtime queries connect as `westbridge_app`,
 * which is bound by tenant_isolation_* policies on every tenant table.
 * Forgetting to use this helper from a worker will return zero rows for
 * that worker's queries — failure mode is loud, not silent.
 *
 * Migrations and intentional cross-tenant cleanup
 * (account-cleanup.service.ts) bypass RLS by running as the schema-owning
 * role via MIGRATION_DATABASE_URL / directUrl.
 *
 * See:
 *   - prisma/migrations/20260318_add_row_level_security/migration.sql
 *   - prisma/migrations/20260409060845_cortex_and_user_scoped_rls/migration.sql
 *   - scripts/provision-rls-role.sh
 */
import { prisma } from "./prisma.js";
import { tenantContextStorage, tenantPinInProgress } from "./tenant-als.js";

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function withTenantScope<T>(accountId: string, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
  // Set the AsyncLocalStorage tenant context so that any code path
  // INSIDE the callback that happens to call `prisma.X.method()`
  // (instead of `tx.X.method()`) still sees the right tenant. The
  // Prisma extension reads this storage on every operation.
  return tenantContextStorage.run({ accountId }, async () => {
    return prisma.$transaction(async (tx) => {
      // is_local=true: this setting only persists for the duration of
      // THIS transaction, which is exactly what we want — when the
      // transaction commits, the next request gets a clean slate.
      await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`;
      // Mark recursion guard so the Prisma `$allOperations` extension
      // doesn't try to open NESTED transactions for each `tx.X.method()`
      // call inside fn — we already have the variable set on this
      // connection, additional pinning would just add overhead (and
      // Prisma rejects nested $transactions).
      return tenantPinInProgress.run(true, () => fn(tx));
    });
  });
}
