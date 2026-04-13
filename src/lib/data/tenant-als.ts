/**
 * Per-request tenant context plumbing for the RLS-enforced Prisma client.
 *
 * Uses Node's AsyncLocalStorage so that the tenant id set by the auth
 * middleware (via `tenantContextStorage.run`) is automatically available
 * to every Prisma query the request handler issues — without having to
 * thread the accountId through every function call.
 *
 * This is the FOUNDATION of the runtime side of v3.0 of the tenant
 * isolation hardening spec. The Prisma `$extends` in
 * `src/lib/data/prisma.ts` reads from this storage and pins the
 * PostgreSQL session variable `app.current_account_id` for the duration
 * of each operation, so RLS policies can filter rows by tenant.
 *
 * USAGE
 * -----
 *
 *   // In requireAuth middleware (after validating the session):
 *   import { tenantContextStorage } from "../lib/data/tenant-als.js";
 *
 *   tenantContextStorage.run({ accountId: session.accountId },  => next);
 *
 *   // Anywhere downstream (route handler, service, helper):
 *   import { prisma } from "../lib/data/prisma.js";
 *
 *   await prisma.user.findMany;   // ← pinned to tenant via the extension
 *
 * The store is read inside the Prisma `$allOperations` extension; you
 * never need to read it directly outside of `prisma.ts`.
 *
 * CROSS-TENANT OPERATIONS
 * -----------------------
 *
 * Code paths that legitimately need to operate across tenants — login
 * lookup, signup INSERT, webhook handlers that mark accounts paid by id
 * from a verified payload, the cleanup worker — MUST use
 * `src/lib/data/prisma-admin.ts` instead of `prisma.ts`. The admin
 * client is intentionally ignorant of `tenantContextStorage` so it can
 * see (and write to) every tenant.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext {
  accountId: string;
}

/**
 * Per-request tenant context. Set by the auth middleware after the
 * session is validated. Read by the Prisma `$extends` tenant-pin
 * extension to bind `app.current_account_id` for each query.
 */
export const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Internal recursion guard for the Prisma extension. When the
 * tenant-pin extension opens its own `$transaction` to set the
 * PostgreSQL variable, the inner queries on the transaction client
 * re-fire `$allOperations`. Without this flag, that re-fire would try
 * to open ANOTHER transaction (Postgres rejects nested transactions
 * via Prisma) and the call would loop or fail.
 *
 * Set to `true` ONLY by the tenant-pin extension — never by user code.
 *
 * Also used by the user-supplied `$transaction(callback)` extension to
 * mark "we already pinned the tenant inside this transaction, don't
 * pin again per query". See the `client.$transaction` override in
 * `prisma.ts` for the pattern.
 */
export const tenantPinInProgress = new AsyncLocalStorage<boolean>();
