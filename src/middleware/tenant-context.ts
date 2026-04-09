/**
 * Express middleware that sets the PostgreSQL session variable for RLS.
 * Must run after auth middleware (needs req.session.accountId).
 *
 * ⚠️ KNOWN LIMITATION — Phase 3 of the tenant isolation hardening spec:
 *
 * This middleware calls `prisma.$executeRaw` OUTSIDE any explicit
 * transaction. PostgreSQL's `set_config(name, value, true)` with
 * `is_local=true` only persists for the current TRANSACTION. Each
 * Prisma operation outside an explicit `$transaction` is its own
 * implicit transaction; it commits as soon as the statement returns,
 * and the next query may be assigned a DIFFERENT connection from the
 * pool that has no `app.current_account_id` set.
 *
 * Empirically verified locally on 2026-04-09: under the `westbridge_app`
 * role (Phase 3 runtime role), this middleware as written returns ZERO
 * rows from every subsequent tenant-scoped query because RLS sees an
 * unset variable and default-denies. Phases 1, 2, 4, and 5 do NOT
 * depend on this middleware working — they ship correctly under the
 * current `postgres` superuser role (which bypasses RLS entirely).
 *
 * BLOCKING FOLLOW-UP before flipping the role switch in Phase 3 of the
 * spec (`scripts/provision-rls-role.sh` + DATABASE_URL change):
 *
 * The recommended fix is one of:
 *   (a) Use Prisma `$extends` with `query.$allOperations` plus an
 *       AsyncLocalStorage tenant-id slot, so every operation runs
 *       inside a per-call transaction with set_config first. This is
 *       the cleanest pattern but requires a refactor of `prisma.ts`.
 *   (b) Wrap every authenticated route handler in `withTenantScope`
 *       and pass the tx client through. Massive refactor across every
 *       route file.
 *   (c) Use a connection-per-request pattern via Prisma's interactive
 *       transaction API and pin it on req. Requires changing every
 *       route to read `req.prisma` instead of importing `prisma`.
 *
 * Until one of those lands, this middleware is best-effort: it WILL
 * pin the variable for any subsequent query that happens to land on
 * the same pooled connection within the same implicit transaction
 * window, but that's a coincidence, not a guarantee.
 *
 * As long as the runtime role is `postgres` (RLS-bypassing), this
 * limitation is harmless because RLS is not consulted at all. Layer 1
 * (route-level WHERE filters) remains the primary isolation mechanism.
 */

import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/data/prisma.js";
import { logger } from "../lib/logger.js";

export async function tenantContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const accountId = req.session?.accountId;

  if (!accountId) {
    next();
    return;
  }

  try {
    // Use tagged template literal (parameterized query) — NOT string interpolation
    await prisma.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`;
  } catch (err) {
    // Log but don't block — RLS is defense-in-depth, not the primary isolation mechanism.
    // Application-level WHERE clauses remain the primary tenant filter.
    logger.warn("Failed to set tenant context for RLS", {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  next();
}
