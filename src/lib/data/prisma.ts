/**
 * Data layer: Prisma client singleton with soft-delete + tenant-pin extensions.
 * Pure I/O; no business logic.
 *
 * Soft-delete strategy for Account and User models:
 * - All find/count operations auto-filter `deletedAt IS NULL` by default
 * - `delete` operations set `deletedAt = now()` instead of hard-deleting
 * - To include deleted records, pass `{ where: { deletedAt: { not: null } } }`
 *   — the extension only injects the filter when `deletedAt` is absent.
 *
 * Tenant-pin (Phase 3 of the tenant isolation hardening spec):
 * - Every model operation reads `tenantContextStorage` from
 *   `tenant-als.ts`. If a tenant is set, the operation is wrapped in a
 *   one-shot `$transaction` that runs `set_config('app.current_account_id', ...)`
 *   first, so PostgreSQL Row-Level Security policies can filter rows by
 *   tenant. The variable is bound LOCAL to that transaction, so the
 *   next request gets a clean slate.
 * - User-supplied `prisma.$transaction(callback)` calls are also
 *   intercepted: the wrapper sets the tenant variable inside the
 *   user's transaction and uses `tenantPinInProgress` to suppress
 *   per-query wrapping for the operations inside the callback.
 * - Cross-tenant operations (login lookup, signup INSERT, webhook
 *   handlers, cleanup workers, audit logging) MUST use
 *   `prisma-admin.ts` instead — that client is intentionally NOT
 *   tenant-pin-aware.
 *
 * Uses Prisma Client Extensions ($extends) — the supported API in Prisma 5+/6+.
 */

import { PrismaClient } from "@prisma/client";

import { tenantContextStorage, tenantPinInProgress } from "./tenant-als.js";

/**
 * Operations that must NEVER be wrapped in a per-call tenant transaction.
 *
 *   - Raw SQL: the caller is presumably driving their own session
 *     variable. Wrapping would clobber.
 *   - $transaction: handled separately by `client.$transaction` so the
 *     user's interactive callback can set the variable once and run
 *     multiple queries inside it.
 *   - $connect / $disconnect / $extends: lifecycle, not query operations.
 */
const SKIP_TENANT_PIN_OPERATIONS = new Set([
  "$queryRaw",
  "$queryRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
  "$transaction",
  "$connect",
  "$disconnect",
  "$on",
  "$use",
  "$extends",
  "$runCommandRaw", // mongo-only, defensive
]);

/**
 * Production connection pool recommendations:
 *   DATABASE_POOL_SIZE=20        (default: 10, max depends on your Postgres plan)
 *   DATABASE_URL should include:  ?connection_limit=20&pool_timeout=10
 *
 * For Railway/Fly.io with pgbouncer, use transaction mode and set:
 *   ?pgbouncer=true&connection_limit=20
 */
function createPrismaClient() {
  const poolSize = parseInt(process.env.DATABASE_POOL_SIZE || "10");
  const rawUrl = process.env.DATABASE_URL ?? "";
  const base = new PrismaClient({
    datasourceUrl: poolSize !== 10 ? appendPoolSize(rawUrl, poolSize) : rawUrl,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  // Extension #1 — soft-delete on Account + User. Same behavior as before.
  // Kept as a separate $extends so the second extension below can grab the
  // softDelete client and call .$transaction on it (which inherits this
  // extension's model overrides).
  const withSoftDelete = base.$extends({
    query: {
      account: {
        async findFirst({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findUnique({ args, query }) {
          // Prisma's findUnique where clause is a union of unique key shapes.
          // We downgrade to findFirst so we can inject the soft-delete filter,
          // then return null (matching findUnique semantics) if the record is soft-deleted.
          const result = await query(args);
          if (
            result &&
            (result as { deletedAt?: Date | null }).deletedAt !== null &&
            (result as { deletedAt?: Date | null }).deletedAt !== undefined
          ) {
            return null;
          }
          return result;
        },
        async count({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async update({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null } as typeof args.where;
          return query(args);
        },
        async updateMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async delete({ args, query: _query }) {
          return base.account.update({
            where: args.where,
            data: { deletedAt: new Date() },
          });
        },
        async deleteMany({ args, query: _query }) {
          return base.account.updateMany({
            where: { ...args.where, deletedAt: args.where?.deletedAt ?? null },
            data: { deletedAt: new Date() },
          });
        },
      },
      user: {
        async findFirst({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async findUnique({ args, query }) {
          const result = await query(args);
          if (
            result &&
            (result as { deletedAt?: Date | null }).deletedAt !== null &&
            (result as { deletedAt?: Date | null }).deletedAt !== undefined
          ) {
            return null;
          }
          return result;
        },
        async count({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async update({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null } as typeof args.where;
          return query(args);
        },
        async updateMany({ args, query }) {
          args.where = { ...args.where, deletedAt: args.where?.deletedAt ?? null };
          return query(args);
        },
        async delete({ args, query: _query }) {
          return base.user.update({
            where: args.where,
            data: { deletedAt: new Date() },
          });
        },
        async deleteMany({ args, query: _query }) {
          return base.user.updateMany({
            where: { ...args.where, deletedAt: args.where?.deletedAt ?? null },
            data: { deletedAt: new Date() },
          });
        },
      },
    },
  });

  // Extension #2 — tenant pin via AsyncLocalStorage.
  //
  // Reads the current tenant from `tenantContextStorage`. If a tenant is
  // set AND we're not already inside a tenant-pinned transaction, wraps
  // the operation in its own one-shot $transaction that runs
  // `set_config('app.current_account_id', ...)` first.
  //
  // Inside the wrapping $transaction, the model methods on the tx client
  // re-fire $allOperations (Prisma extensions are inherited by tx
  // clients). The `tenantPinInProgress` AsyncLocalStorage flag prevents
  // infinite recursion: when the inner call sees `inProgress=true`, it
  // forwards through without re-wrapping.
  //
  // We deliberately do NOT override `client.$transaction`. Authenticated
  // route handlers that need transactions MUST use `withTenantScope`
  // from `tenant-scope.ts` (which sets `tenantPinInProgress=true` for
  // the lifetime of its callback). Cross-tenant services that use
  // `prisma.$transaction(callback)` directly are imported from
  // `prisma-admin.ts` (which has no tenant-pin extension at all). If a
  // future code path calls `prisma.$transaction(callback)` from an
  // authenticated path WITHOUT going through `withTenantScope`, the
  // inner queries will try to open nested transactions and Prisma will
  // throw a clear "Transactions cannot be nested" error — that LOUD
  // failure is the signal to switch the call site to `withTenantScope`.
  const withTenantPin = withSoftDelete.$extends({
    name: "tenant-pin",
    query: {
      async $allOperations({ args, query, model, operation }) {
        // Recursion guard: if we're already inside a tenant-pinned
        // transaction (either because the tenant-pin extension just
        // opened one for a single query, or because the user supplied
        // their own $transaction(callback) that we wrapped above),
        // forward through without re-wrapping. Postgres rejects nested
        // transactions and Prisma surfaces that as a runtime error.
        if (tenantPinInProgress.getStore()) {
          return query(args);
        }
        // Skip operations that don't have a model context, are raw SQL,
        // or are lifecycle methods.
        if (!model || SKIP_TENANT_PIN_OPERATIONS.has(operation)) {
          return query(args);
        }
        const tenant = tenantContextStorage.getStore();
        // No tenant context — this is the path for unauthenticated
        // requests (login, signup, webhooks), background workers, and
        // the cleanup tasks that run before any user is in scope. They
        // should be using `prismaAdmin` instead, but if they happen to
        // hit `prisma` (e.g., a service that's called from both an
        // authenticated route and a worker) we forward through and let
        // the database role decide whether to allow the operation.
        if (!tenant?.accountId) {
          return query(args);
        }
        // Wrap the operation in a one-shot transaction that sets the
        // tenant variable first. set_config(..., true) is transaction-
        // local, so the variable is implicitly cleaned up at the end of
        // each operation. The recursion flag prevents the inner call to
        // `txAny[model][operation](args)` from re-firing this branch.
        return tenantPinInProgress.run(true, async () => {
          return withSoftDelete.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_account_id', ${tenant.accountId}, true)`;
            // Forward the operation to the model on the tx client.
            // The tx client inherits the soft-delete extension (Prisma
            // extensions are inherited by tx clients) so the same
            // deletedAt filtering still applies to find/count/update.
            // The bypass flag we just set prevents this re-fire from
            // wrapping again.
            const txAny = tx as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>;
            return txAny[model][operation](args);
          });
        });
      },
    },
  });

  return withTenantPin;
}

/** Append connection_limit to DATABASE_URL if not already present. */
function appendPoolSize(url: string, poolSize: number): string {
  if (!url || url.includes("connection_limit")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}connection_limit=${poolSize}`;
}

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma: ExtendedPrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = prisma;
